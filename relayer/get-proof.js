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

import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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

const treeData = JSON.parse(fs.readFileSync(treeFile, "utf-8"));
const tree = StandardMerkleTree.load(treeData);
const targetNonce = BigInt(nonceArg).toString();

let found = false;
for (const [i, [recipient, amount, nonce]] of tree.entries()) {
  if (nonce === targetNonce) {
    const proof = tree.getProof(i);
    console.log(
      JSON.stringify(
        {
          recipient,
          amount,
          nonce,
          proof,
          merkleRoot: tree.root,
        },
        null,
        2
      )
    );
    found = true;
    break;
  }
}

if (!found) {
  console.error(`Nonce ${nonceArg} not found in current Merkle tree for direction "${direction}".`);
  console.error("The relayer may not have included it yet, or it may already be claimed.");
  process.exit(1);
}
