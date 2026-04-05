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

import { MerkleTree } from "merkletreejs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { makeLeaf, keccak256buf } from "./relay.js";

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

const [recipient, amount, nonce] = entry;
const leaf = makeLeaf(recipient, amount, nonce);
const proof = tree.getHexProof(leaf);

console.log(JSON.stringify({ recipient, amount, nonce, proof, merkleRoot: tree.getHexRoot() }, null, 2));
