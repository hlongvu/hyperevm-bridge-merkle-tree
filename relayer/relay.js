/**
 * Core relay logic — exported for testing and reuse.
 */

import { ethers } from "ethers";
import { MerkleTree } from "merkletreejs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BRIDGE_ABI = [
  "event BridgeInitiated(address indexed sender, address indexed recipient, uint256 amount, uint256 nonce)",
  "function setMerkleRoot(bytes32 root) external",
  "function merkleRoot() view returns (bytes32)",
  "function processedNonces(uint256) view returns (bool)",
  "function destChainId() view returns (uint256)",
];

export const BLOCK_RANGE = 500;

export function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

export function loadState(stateFile) {
  if (fs.existsSync(stateFile)) {
    return JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  }
  return { sepolia: 0, hyperevm: 0 };
}

export function saveState(stateFile, state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// ─── Merkle helpers ──────────────────────────────────────────────────────────

/**
 * keccak256 wrapper that returns a Buffer — required by merkletreejs as hash fn.
 */
export function keccak256buf(data) {
  return Buffer.from(ethers.keccak256(data).slice(2), "hex");
}

/**
 * Build a leaf buffer matching the on-chain encoding:
 *   keccak256(abi.encodePacked(recipient, amount, nonce))
 */
export function makeLeaf(recipient, amount, nonce) {
  return Buffer.from(
    ethers.keccak256(
      ethers.solidityPacked(
        ["address", "uint256", "uint256"],
        [recipient, BigInt(amount), BigInt(nonce)]
      )
    ).slice(2),
    "hex"
  );
}

// ─── Core relay logic ────────────────────────────────────────────────────────

/**
 * Append new events to an existing MerkleTree (or create one) and post the
 * updated root on-chain via setMerkleRoot().
 *
 * Save file format:
 *   { tree: MerkleTree.marshalTree(tree), entries: [[recipient, amount, nonce], ...] }
 *
 * @param {object} opts
 * @param {string}  opts.name      - Human-readable direction label
 * @param {Array}   opts.events    - ethers EventLog[] from queryFilter
 * @param {object}  opts.dstBridge - ethers Contract (with signer) on destination chain
 * @param {string}  [opts.treeDir] - Directory to persist tree JSON (default: relayer/)
 * @returns {MerkleTree|null}
 */
export async function buildAndPostMerkleRoot({ name, events, dstBridge, treeDir }) {
  if (events.length === 0) {
    log(`[${name}] No new events`);
    return null;
  }

  const dir = treeDir ?? __dirname;
  const safeName = name.replace(/[^a-z0-9]/gi, "_");
  const treeFile = path.join(dir, `merkle-tree-${safeName}.json`);

  // ── Load existing tree or create a fresh one ────────────────────────────────
  let tree;
  let savedEntries = [];

  if (fs.existsSync(treeFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(treeFile, "utf-8"));
      tree = MerkleTree.unmarshalTree(saved.tree, keccak256buf, { sortPairs: true });
      savedEntries = saved.entries;
      log(`[${name}] Loaded existing tree (${savedEntries.length} entries)`);
    } catch (err) {
      log(`[${name}] Could not load previous tree (starting fresh): ${err.message}`);
      tree = new MerkleTree([], keccak256buf, { sortPairs: true });
    }
  } else {
    tree = new MerkleTree([], keccak256buf, { sortPairs: true });
  }

  // ── Add new leaves ──────────────────────────────────────────────────────────
  const newEntries = events.map(({ args }) => [
    args.recipient,
    args.amount.toString(),
    args.nonce.toString(),
  ]);
  tree.addLeaves(newEntries.map(([r, a, n]) => makeLeaf(r, a, n)));
  log(`[${name}] Added ${newEntries.length} new leaf(ves) — tree now has ${savedEntries.length + newEntries.length} entries`);

  const root = tree.getHexRoot();
  log(`[${name}] Merkle root: ${root}`);

  // ── Persist tree + full entries list ───────────────────────────────────────
  fs.writeFileSync(treeFile, JSON.stringify({
    tree: MerkleTree.marshalTree(tree),
    entries: [...savedEntries, ...newEntries],
  }, null, 2));
  log(`[${name}] Tree saved to ${treeFile}`);

  // ── Post root on-chain ──────────────────────────────────────────────────────
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
 * Scan one poll window of BridgeInitiated events on the source chain and,
 * if any are found, build + post a Merkle root on the destination chain.
 *
 * @param {object} opts
 * @param {string}  opts.name      - Human-readable direction label
 * @param {string}  opts.stateKey  - Key in `state` object ("sepolia" | "hyperevm")
 * @param {object}  opts.srcBridge - ethers Contract (read-only) on source chain
 * @param {object}  opts.dstBridge - ethers Contract (with signer) on destination chain
 * @param {object}  opts.state     - Mutable state object { sepolia: number, hyperevm: number }
 * @param {string}  opts.stateFile - Path to persist state JSON
 * @param {string}  [opts.treeDir] - Directory to persist tree JSON
 */
export async function relayDirection({ name, stateKey, srcBridge, dstBridge, state, stateFile, treeDir }) {
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
    saveState(stateFile, state);
    return;
  }

  log(`[${name}] Found ${events.length} BridgeInitiated event(s)`);

  const tree = await buildAndPostMerkleRoot({ name, events, dstBridge, treeDir });

  // Only advance the block pointer when the root was successfully posted on-chain.
  // If setMerkleRoot() failed, keep state unchanged so the events are re-scanned next poll.
  if (tree === null) {
    log(`[${name}] Root not posted — state NOT advanced, will retry next poll`);
    return;
  }

  state[stateKey] = toBlock;
  saveState(stateFile, state);
}
