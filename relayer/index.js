/**
 * Bridge Relayer
 *
 * Polls BridgeInitiated events on both chains and calls release() on the
 * destination chain after signing the payload with the relayer private key.
 *
 * State is persisted to relayer/state.json (last processed block per chain).
 *
 * Usage:
 *   node relayer/index.js
 */

import { ethers } from "ethers";
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
  "function release(address recipient, uint256 amount, uint256 nonce, bytes calldata sig) external",
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

/**
 * Build the relayer signature for a release() call.
 * Mirrors the hash in Bridge.sol:
 *   keccak256(abi.encodePacked(destChainId, recipient, amount, nonce))
 */
async function signRelease(wallet, destChainId, recipient, amount, nonce) {
  const hash = ethers.solidityPackedKeccak256(
    ["uint256", "address", "uint256", "uint256"],
    [destChainId, recipient, amount, nonce]
  );
  return wallet.signMessage(ethers.getBytes(hash));
}

// ─── Core relay logic ────────────────────────────────────────────────────────

/**
 * Poll events on `srcChain` and relay them to `dstChain`.
 */
async function relayDirection({ name, stateKey, srcBridge, dstBridge, wallet, destChainId, state }) {
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

  for (const event of events) {
    const { recipient, amount, nonce } = event.args;
    const nonceNum = Number(nonce);

    log(`[${name}] Event: recipient=${recipient} amount=${ethers.formatEther(amount)} nonce=${nonceNum} tx=${event.transactionHash}`);

    let alreadyProcessed;
    try {
      alreadyProcessed = await dstBridge.processedNonces(nonce);
    } catch (err) {
      log(`[${name}] processedNonces check failed: ${err.message}`);
      continue;
    }

    if (alreadyProcessed) {
      log(`[${name}] Nonce ${nonceNum} already processed, skipping`);
      continue;
    }

    let sig;
    try {
      sig = await signRelease(wallet, destChainId, recipient, amount, nonce);
    } catch (err) {
      log(`[${name}] Signing failed: ${err.message}`);
      continue;
    }

    let tries = 0;
    const MAX_TRIES = 3;
    while (tries < MAX_TRIES) {
      tries++;
      try {
        log(`[${name}] Submitting release() for nonce ${nonceNum} (attempt ${tries})`);
        const tx = await dstBridge.release(recipient, amount, nonce, sig);
        const receipt = await tx.wait();
        log(`[${name}] release() confirmed in tx ${receipt.hash} (block ${receipt.blockNumber})`);
        break;
      } catch (err) {
        log(`[${name}] release() failed (attempt ${tries}): ${err.message}`);
        if (tries === MAX_TRIES) {
          log(`[${name}] Giving up on nonce ${nonceNum} after ${MAX_TRIES} attempts`);
        } else {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }
  }

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
        wallet: hyperevmWallet,
        destChainId: BigInt(hyperevmDep.chainId),
        state,
      });

      // Direction B: HyperEVM → Sepolia
      await relayDirection({
        name: "HyperEVM→Sepolia",
        stateKey: "hyperevm",
        srcBridge: hyperevmBridgeRead,
        dstBridge: sepoliaBridgeWrite,
        wallet: sepoliaWallet,
        destChainId: BigInt(sepoliaDep.chainId),
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
