/**
 * Bridge Relayer
 *
 * Polls BridgeInitiated events on both chains, batches pending transfers into
 * a Merkle tree, and posts the root on-chain via setMerkleRoot(). Users then
 * claim their funds by submitting a Merkle proof to Bridge.claim().
 *
 * State is persisted to relayer/state.json (last processed block per chain).
 * Tree data is persisted to relayer/merkle-tree-<direction>.json for proof lookup.
 *
 * Usage:
 *   node relayer/index.js
 */

import { ethers } from "ethers";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ─────────────────────────────────────────────────────────────────

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL;
const HYPEREVM_RPC = process.env.HYPEREVM_RPC_URL || "https://rpc.hyperliquid-testnet.xyz/evm";
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;

if (!SEPOLIA_RPC) throw new Error("SEPOLIA_RPC_URL not set");
if (!RELAYER_PRIVATE_KEY) throw new Error("RELAYER_PRIVATE_KEY not set");

const POLL_INTERVAL_MS = 12_000; // 12 seconds
const BLOCK_RANGE = 500;         // fetch up to 500 blocks per poll
const STATE_FILE = path.join(__dirname, "state.json");

const BRIDGE_ABI = [
  "event BridgeInitiated(address indexed sender, address indexed recipient, uint256 amount, uint256 nonce)",
  "function setMerkleRoot(bytes32 root) external",
  "function merkleRoot() view returns (bytes32)",
  "function processedNonces(uint256) view returns (bool)",
  "function destChainId() view returns (uint256)",
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  }
  return { sepolia: 0, hyperevm: 0 };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ─── Core relay logic ────────────────────────────────────────────────────────

/**
 * Build a StandardMerkleTree from ALL unclaimed transfers and post the root on-chain.
 * Combines entries carried over from the previous tree with any new events from this
 * poll window, so users who bridged in earlier batches are never dropped from the tree.
 * Saves the full tree to disk so users can query proofs via get-proof.js.
 */
async function buildAndPostMerkleRoot({ name, events, dstBridge }) {
  const safeName = name.replace(/[^a-z0-9]/gi, "_");
  const treeFile = path.join(__dirname, `merkle-tree-${safeName}.json`);

  // ── Seed from previous tree (carry-forward unclaimed entries) ──────────────
  // Use a map keyed by nonce so duplicates between old tree and new events
  // are naturally deduplicated (new event wins, same data either way).
  const entriesByNonce = new Map(); // nonce (string) → [recipient, amount, nonce]

  if (fs.existsSync(treeFile)) {
    try {
      const prev = StandardMerkleTree.load(JSON.parse(fs.readFileSync(treeFile, "utf-8")));
      for (const [, leaf] of prev.entries()) {
        entriesByNonce.set(leaf[2], leaf); // leaf[2] = nonce
      }
      log(`[${name}] Loaded ${entriesByNonce.size} entries from previous tree`);
    } catch (err) {
      log(`[${name}] Could not load previous tree (starting fresh): ${err.message}`);
    }
  }

  // ── Merge new events ────────────────────────────────────────────────────────
  for (const event of events) {
    const { recipient, amount, nonce } = event.args;
    entriesByNonce.set(nonce.toString(), [recipient, amount.toString(), nonce.toString()]);
  }

  const pending = [...entriesByNonce.values()];

  if (pending.length === 0) {
    log(`[${name}] No entries to include in tree`);
    return null;
  }

  log(`[${name}] Building Merkle tree for ${pending.length} transfer(s)`);
  const tree = StandardMerkleTree.of(pending, ["address", "uint256", "uint256"]);
  const root = tree.root;
  log(`[${name}] Merkle root: ${root}`);

  // Persist the full tree so users can query proofs
  fs.writeFileSync(treeFile, JSON.stringify(tree.dump(), null, 2));
  log(`[${name}] Tree saved to ${treeFile}`);

  let tries = 0;
  const MAX_TRIES = 3;
  while (tries < MAX_TRIES) {
    tries++;
    try {
      log(`[${name}] Posting setMerkleRoot() (attempt ${tries})`);
      const tx = await dstBridge.setMerkleRoot(root);
      const receipt = await tx.wait();
      log(`[${name}] setMerkleRoot() confirmed in tx ${receipt.hash} (block ${receipt.blockNumber})`);
      return tree;
    } catch (err) {
      log(`[${name}] setMerkleRoot() failed (attempt ${tries}): ${err.message}`);
      if (tries === MAX_TRIES) {
        log(`[${name}] Giving up after ${MAX_TRIES} attempts`);
        return null;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

/**
 * Poll events on `srcChain` and relay them to `dstChain`.
 */
async function relayDirection({ name, stateKey, srcBridge, dstBridge, state }) {
  const provider = srcBridge.runner.provider ?? srcBridge.runner;
  const latestBlock = await provider.getBlockNumber();

  const fromBlock = state[stateKey] + 1;
  const toBlock = Math.min(fromBlock + BLOCK_RANGE - 1, latestBlock);

  if (fromBlock > latestBlock) {
    log(`[${name}] No new blocks (latest=${latestBlock})`);
    return;
  }

  log(`[${name}] Scanning blocks ${fromBlock}–${toBlock} (latest=${latestBlock})`);

  let events;
  try {
    events = await srcBridge.queryFilter(srcBridge.filters.BridgeInitiated(), fromBlock, toBlock);
  } catch (err) {
    log(`[${name}] queryFilter error: ${err.message}`);
    return;
  }

  if (events.length === 0) {
    log(`[${name}] No events found`);
    state[stateKey] = toBlock;
    saveState(state);
    return;
  }

  log(`[${name}] Found ${events.length} BridgeInitiated event(s)`);

  await buildAndPostMerkleRoot({ name, events, dstBridge });

  state[stateKey] = toBlock;
  saveState(state);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log("Starting bridge relayer...");

  const sepoliaProvider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const hyperevmProvider = new ethers.JsonRpcProvider(HYPEREVM_RPC);

  const sepoliaWallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, sepoliaProvider);
  const hyperevmWallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, hyperevmProvider);

  const sepoliaDep = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../deployments/sepolia.json"), "utf-8")
  );
  const hyperevmDep = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../deployments/hyperevm.json"), "utf-8")
  );

  const sepoliaBridgeRead = new ethers.Contract(sepoliaDep.bridge, BRIDGE_ABI, sepoliaProvider);
  const hyperevmBridgeRead = new ethers.Contract(hyperevmDep.bridge, BRIDGE_ABI, hyperevmProvider);
  const sepoliaBridgeWrite = new ethers.Contract(sepoliaDep.bridge, BRIDGE_ABI, sepoliaWallet);
  const hyperevmBridgeWrite = new ethers.Contract(hyperevmDep.bridge, BRIDGE_ABI, hyperevmWallet);

  log(`Sepolia  bridge: ${sepoliaDep.bridge}`);
  log(`HyperEVM bridge: ${hyperevmDep.bridge}`);
  log(`Relayer address: ${sepoliaWallet.address}`);

  const state = loadState();
  if (state.sepolia === 0) {
    state.sepolia = (await sepoliaProvider.getBlockNumber()) - 1;
    log(`Initialized Sepolia start block: ${state.sepolia}`);
  }
  if (state.hyperevm === 0) {
    state.hyperevm = (await hyperevmProvider.getBlockNumber()) - 1;
    log(`Initialized HyperEVM start block: ${state.hyperevm}`);
  }
  saveState(state);

  log(`Poll interval: ${POLL_INTERVAL_MS}ms`);

  async function poll() {
    try {
      // Direction A: Sepolia → HyperEVM
      await relayDirection({
        name: "Sepolia→HyperEVM",
        stateKey: "sepolia",
        srcBridge: sepoliaBridgeRead,
        dstBridge: hyperevmBridgeWrite,
        state,
      });

      // Direction B: HyperEVM → Sepolia
      await relayDirection({
        name: "HyperEVM→Sepolia",
        stateKey: "hyperevm",
        srcBridge: hyperevmBridgeRead,
        dstBridge: sepoliaBridgeWrite,
        state,
      });
    } catch (err) {
      log(`Poll error: ${err.message}`);
    }

    setTimeout(poll, POLL_INTERVAL_MS);
  }

  poll();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
