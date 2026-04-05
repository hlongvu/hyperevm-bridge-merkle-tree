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
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import { BRIDGE_ABI, log, loadState, saveState, relayDirection } from "./relay.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ─────────────────────────────────────────────────────────────────

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL;
const HYPEREVM_RPC = process.env.HYPEREVM_RPC_URL || "https://rpc.hyperliquid-testnet.xyz/evm";
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;

if (!SEPOLIA_RPC) throw new Error("SEPOLIA_RPC_URL not set");
if (!RELAYER_PRIVATE_KEY) throw new Error("RELAYER_PRIVATE_KEY not set");

const POLL_INTERVAL_MS = 12_000; // 12 seconds
const STATE_FILE = path.join(__dirname, "state.json");

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

  const state = loadState(STATE_FILE);
  if (state.sepolia === 0) {
    state.sepolia = (await sepoliaProvider.getBlockNumber()) - 1;
    log(`Initialized Sepolia start block: ${state.sepolia}`);
  }
  if (state.hyperevm === 0) {
    state.hyperevm = (await hyperevmProvider.getBlockNumber()) - 1;
    log(`Initialized HyperEVM start block: ${state.hyperevm}`);
  }
  saveState(STATE_FILE, state);

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
        stateFile: STATE_FILE,
      });

      // Direction B: HyperEVM → Sepolia
      await relayDirection({
        name: "HyperEVM→Sepolia",
        stateKey: "hyperevm",
        srcBridge: hyperevmBridgeRead,
        dstBridge: sepoliaBridgeWrite,
        state,
        stateFile: STATE_FILE,
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
