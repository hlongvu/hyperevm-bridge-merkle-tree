/**
 * Get a Merkle proof for a specific bridge transfer.
 *
 * Usage:
 *   node relayer/get-proof.js <direction> <nonce>
 *
 * Example:
 *   node relayer/get-proof.js Sepolia__HyperEVM 42
 *
 * The direction matches the sanitized name used by the relayer, e.g.:
 *   "Sepolia_HyperEVM" for Sepolia→HyperEVM
 *   "HyperEVM_Sepolia" for HyperEVM→Sepolia
 *
 * The proof output can be passed directly to Bridge.claim() on-chain.
 */

import { ethers } from "ethers";
import { MerkleTree } from "merkletreejs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import { makeLeaf, keccak256buf, BRIDGE_ABI } from "./relay.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [, , direction, nonceArg] = process.argv;
if (!direction || !nonceArg) {
  console.error("Usage: node relayer/get-proof.js <direction> <nonce>");
  console.error("Example: node relayer/get-proof.js Sepolia__HyperEVM 0");
  process.exit(1);
}

const treeFile = path.join(__dirname, `merkle-tree-${direction}.json`);
if (!fs.existsSync(treeFile)) {
  console.error(`Tree file not found: ${treeFile}`);
  console.error("Has the relayer posted a Merkle root for this direction yet?");
  console.error("Available tree files:", fs.readdirSync(__dirname).filter((f) => f.startsWith("merkle-tree-")));
  process.exit(1);
}

const saved = JSON.parse(fs.readFileSync(treeFile, "utf-8"));
const tree = MerkleTree.unmarshalTree(saved.tree, keccak256buf, { sortPairs: true });
const targetNonce = BigInt(nonceArg).toString();

const entry = saved.entries.find(([, , n]) => n === targetNonce);
if (!entry) {
  console.error(`Nonce ${nonceArg} not found in current tree for direction "${direction}".`);
  console.error("The relayer may not have included it yet.");
  process.exit(1);
}

// ── Verify local root matches on-chain root ──────────────────────────────────
// Derive the destination chain from the direction name and check the live
// merkleRoot() value so we don't hand out a proof for a stale/overwritten root.
const localRoot = tree.getHexRoot();

try {
  // direction format after sanitization: "Sepolia_HyperEVM" or "HyperEVM_Sepolia"
  const isToHyperEVM = direction.toLowerCase().includes("hyperevm") &&
    direction.toLowerCase().indexOf("hyperevm") > direction.toLowerCase().indexOf("sepolia");

  const depFile = isToHyperEVM
    ? path.join(__dirname, "../deployments/hyperevm.json")
    : path.join(__dirname, "../deployments/sepolia.json");

  const rpcUrl = isToHyperEVM
    ? (process.env.HYPEREVM_RPC_URL || "https://rpc.hyperliquid-testnet.xyz/evm")
    : process.env.SEPOLIA_RPC_URL;

  if (fs.existsSync(depFile) && rpcUrl) {
    const dep = JSON.parse(fs.readFileSync(depFile, "utf-8"));
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const bridge = new ethers.Contract(dep.bridge, BRIDGE_ABI, provider);
    const onChainRoot = await bridge.merkleRoot();

    if (onChainRoot.toLowerCase() !== localRoot.toLowerCase()) {
      console.error("ERROR: Local tree root does NOT match on-chain merkleRoot.");
      console.error(`  Local  : ${localRoot}`);
      console.error(`  On-chain: ${onChainRoot}`);
      console.error("The root on-chain may have been updated since this tree was saved.");
      console.error("Wait for the relayer to re-include your transfer, then retry.");
      process.exit(1);
    }
    console.error(`[ok] On-chain root matches local tree: ${onChainRoot}`);
  } else {
    console.error("[warn] Could not verify on-chain root (deployment file or RPC URL missing). Proceeding without verification.");
  }
} catch (err) {
  console.error(`[warn] On-chain root check failed: ${err.message}. Proceeding without verification.`);
}

// ── Output proof ─────────────────────────────────────────────────────────────
const [recipient, amount, nonce] = entry;
const leaf = makeLeaf(recipient, amount, nonce);
const proof = tree.getHexProof(leaf);

console.log(JSON.stringify({ recipient, amount, nonce, proof, merkleRoot: localRoot }, null, 2));
