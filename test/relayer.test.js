/**
 * Relayer integration tests
 *
 * Both bridge "sides" are deployed on the single Hardhat local chain.
 * relayDirection() is called directly (imported from relayer/relay.js) so we
 * test the real relay logic without spawning external processes.
 *
 * Tree JSON files are written to a temp directory per test to stay isolated.
 */

import { expect } from "chai";
import { network } from "hardhat";
import { MerkleTree } from "merkletreejs";
import fs from "fs";
import os from "os";
import path from "path";
import BridgeSepoliaModule from "../ignition/modules/BridgeSepolia.js";
import BridgeHyperEVMModule from "../ignition/modules/BridgeHyperEVM.js";
import { relayDirection, buildAndPostMerkleRoot, BRIDGE_ABI, makeLeaf, keccak256buf } from "../relayer/relay.js";

const connection = await network.connect();
const { ethers, ignition } = connection;

// ─── Fixture ─────────────────────────────────────────────────────────────────

let deployCount = 0;

async function deployBridge(relayerAddress) {
  const id = deployCount++;
  const params = { relayer: relayerAddress };

  const { token: srcToken, bridge: srcBridge } = await ignition.deploy(
    BridgeSepoliaModule,
    { parameters: { BridgeSepolia: params }, deploymentId: `rel-sepolia-${id}` }
  );
  const { token: dstToken, bridge: dstBridge } = await ignition.deploy(
    BridgeHyperEVMModule,
    { parameters: { BridgeHyperEVM: params }, deploymentId: `rel-hyperevm-${id}` }
  );

  return { srcToken, srcBridge, dstToken, dstBridge };
}

// Wrap an ethers Contract in a signer so it can send transactions
function withSigner(contract, signer) {
  return contract.connect(signer);
}

// Load a saved tree and get hex proof for a nonce
function getProofFromFile(treeFile, nonce) {
  const saved = JSON.parse(fs.readFileSync(treeFile, "utf-8"));
  const tree = MerkleTree.unmarshalTree(saved.tree, keccak256buf, { sortPairs: true });
  const target = BigInt(nonce).toString();
  const entry = saved.entries.find(([, , n]) => n === target);
  if (!entry) throw new Error(`Nonce ${nonce} not found in tree file`);
  const [recipient, amount, n] = entry;
  return { proof: tree.getHexProof(makeLeaf(recipient, amount, n)), root: tree.getHexRoot() };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Relayer", function () {
  let relayer, user, other;
  let srcToken, srcBridge, dstToken, dstBridge;
  let srcBridgeRead, dstBridgeWrite;
  let treeDir, stateFile, state;

  beforeEach(async function () {
    [, relayer, user, other] = await ethers.getSigners();

    ({ srcToken, srcBridge, dstToken, dstBridge } = await deployBridge(relayer.address));

    // Read-only contract on source, write contract (relayer wallet) on destination
    srcBridgeRead = srcBridge;
    dstBridgeWrite = withSigner(dstBridge, relayer);

    // Give user tokens
    await srcToken.connect(user).faucet();

    // Isolated temp dir and state file per test
    treeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-relay-"));
    stateFile = path.join(treeDir, "state.json");

    // Start state from the block before we deploy so we catch all events
    const currentBlock = await ethers.provider.getBlockNumber();
    state = { sepolia: currentBlock - 1, hyperevm: currentBlock - 1 };
  });

  afterEach(function () {
    fs.rmSync(treeDir, { recursive: true, force: true });
  });

  // ─── buildAndPostMerkleRoot ────────────────────────────────────────────────

  describe("buildAndPostMerkleRoot()", function () {
    it("posts merkle root on-chain from a single event", async function () {
      const amount = ethers.parseEther("50");
      await srcToken.connect(user).approve(await srcBridge.getAddress(), amount);
      await srcBridge.connect(user).bridge(amount, other.address);

      const events = await srcBridge.queryFilter(srcBridge.filters.BridgeInitiated());

      await buildAndPostMerkleRoot({
        name: "test",
        events,
        dstBridge: dstBridgeWrite,
        treeDir,
      });

      expect(await dstBridge.merkleRoot()).to.not.equal(ethers.ZeroHash);
    });

    it("saves tree JSON to treeDir", async function () {
      const amount = ethers.parseEther("50");
      await srcToken.connect(user).approve(await srcBridge.getAddress(), amount);
      await srcBridge.connect(user).bridge(amount, other.address);

      const events = await srcBridge.queryFilter(srcBridge.filters.BridgeInitiated());
      await buildAndPostMerkleRoot({ name: "my_dir", events, dstBridge: dstBridgeWrite, treeDir });

      expect(fs.existsSync(path.join(treeDir, "merkle-tree-my_dir.json"))).to.equal(true);
    });

    it("proof from saved tree is valid for claim()", async function () {
      const amount = ethers.parseEther("50");
      await srcToken.connect(user).approve(await srcBridge.getAddress(), amount);
      await srcBridge.connect(user).bridge(amount, other.address);

      const events = await srcBridge.queryFilter(srcBridge.filters.BridgeInitiated());
      await buildAndPostMerkleRoot({ name: "A", events, dstBridge: dstBridgeWrite, treeDir });

      const { proof, root } = getProofFromFile(path.join(treeDir, "merkle-tree-A.json"), 0);
      await expect(dstBridge.connect(other).claim(proof, root, other.address, amount, 0n))
        .to.emit(dstBridge, "BridgeClaimed")
        .withArgs(other.address, amount, 0n);
    });

    it("carries forward previous tree entries when new events arrive", async function () {
      const amount = ethers.parseEther("50");

      // First bridge call — batch 1
      await srcToken.connect(user).approve(await srcBridge.getAddress(), amount);
      await srcBridge.connect(user).bridge(amount, other.address);
      const events1 = await srcBridge.queryFilter(srcBridge.filters.BridgeInitiated());
      await buildAndPostMerkleRoot({ name: "B", events: events1, dstBridge: dstBridgeWrite, treeDir });

      // Second bridge call — batch 2 (new events only)
      await srcToken.connect(user).approve(await srcBridge.getAddress(), amount);
      await srcBridge.connect(user).bridge(amount, user.address);
      const events2 = await srcBridge.queryFilter(
        srcBridge.filters.BridgeInitiated(),
        (await ethers.provider.getBlockNumber()),
        (await ethers.provider.getBlockNumber())
      );
      // Pass only the second event — nonce 0 must still be in the tree via carry-forward
      const events2Only = (await srcBridge.queryFilter(srcBridge.filters.BridgeInitiated()))
        .filter((e) => e.args.nonce.toString() === "1");
      await buildAndPostMerkleRoot({ name: "B", events: events2Only, dstBridge: dstBridgeWrite, treeDir });

      // Both nonces must be provable from the latest tree
      const { proof: proof0, root: root0 } = getProofFromFile(path.join(treeDir, "merkle-tree-B.json"), 0);
      const { proof: proof1, root: root1 } = getProofFromFile(path.join(treeDir, "merkle-tree-B.json"), 1);

      await dstBridge.connect(other).claim(proof0, root0, other.address, amount, 0n);
      await dstBridge.connect(user).claim(proof1, root1, user.address, amount, 1n);

      expect(await dstToken.balanceOf(other.address)).to.equal(amount);
      expect(await dstToken.balanceOf(user.address)).to.equal(amount);
    });

    it("returns null and skips setMerkleRoot when there are no events", async function () {
      const result = await buildAndPostMerkleRoot({
        name: "empty",
        events: [],
        dstBridge: dstBridgeWrite,
        treeDir,
      });

      expect(result).to.equal(null);
      expect(await dstBridge.merkleRoot()).to.equal(ethers.ZeroHash);
    });
  });

  // ─── relayDirection ────────────────────────────────────────────────────────

  describe("relayDirection()", function () {
    it("scans events and posts merkle root on destination", async function () {
      const amount = ethers.parseEther("50");
      await srcToken.connect(user).approve(await srcBridge.getAddress(), amount);
      await srcBridge.connect(user).bridge(amount, other.address);

      await relayDirection({
        name: "Sepolia→HyperEVM",
        stateKey: "sepolia",
        srcBridge: srcBridgeRead,
        dstBridge: dstBridgeWrite,
        state,
        stateFile,
        treeDir,
      });

      expect(await dstBridge.merkleRoot()).to.not.equal(ethers.ZeroHash);
    });

    it("advances state to the latest scanned block", async function () {
      const amount = ethers.parseEther("50");
      await srcToken.connect(user).approve(await srcBridge.getAddress(), amount);
      await srcBridge.connect(user).bridge(amount, other.address);

      const latestBefore = await ethers.provider.getBlockNumber();

      await relayDirection({
        name: "Sepolia→HyperEVM",
        stateKey: "sepolia",
        srcBridge: srcBridgeRead,
        dstBridge: dstBridgeWrite,
        state,
        stateFile,
        treeDir,
      });

      expect(state.sepolia).to.be.gte(latestBefore);
    });

    it("persists state to stateFile", async function () {
      const amount = ethers.parseEther("50");
      await srcToken.connect(user).approve(await srcBridge.getAddress(), amount);
      await srcBridge.connect(user).bridge(amount, other.address);

      await relayDirection({
        name: "Sepolia→HyperEVM",
        stateKey: "sepolia",
        srcBridge: srcBridgeRead,
        dstBridge: dstBridgeWrite,
        state,
        stateFile,
        treeDir,
      });

      expect(fs.existsSync(stateFile)).to.equal(true);
      const saved = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(saved.sepolia).to.equal(state.sepolia);
    });

    it("skips setMerkleRoot when no events in range", async function () {
      // Set state to current block so the scan window has no events
      state.sepolia = await ethers.provider.getBlockNumber();

      await relayDirection({
        name: "Sepolia→HyperEVM",
        stateKey: "sepolia",
        srcBridge: srcBridgeRead,
        dstBridge: dstBridgeWrite,
        state,
        stateFile,
        treeDir,
      });

      expect(await dstBridge.merkleRoot()).to.equal(ethers.ZeroHash);
    });

    it("user can claim after relay runs", async function () {
      const amount = ethers.parseEther("50");
      await srcToken.connect(user).approve(await srcBridge.getAddress(), amount);
      await srcBridge.connect(user).bridge(amount, other.address);

      await relayDirection({
        name: "C",
        stateKey: "sepolia",
        srcBridge: srcBridgeRead,
        dstBridge: dstBridgeWrite,
        state,
        stateFile,
        treeDir,
      });

      const { proof, root } = getProofFromFile(path.join(treeDir, "merkle-tree-C.json"), 0);
      await dstBridge.connect(other).claim(proof, root, other.address, amount, 0n);
      expect(await dstToken.balanceOf(other.address)).to.equal(amount);
    });

    it("multiple bridge events in one poll — all included in tree", async function () {
      const amount = ethers.parseEther("30");
      await srcToken.connect(user).approve(await srcBridge.getAddress(), amount * 3n);
      await srcBridge.connect(user).bridge(amount, other.address);
      await srcBridge.connect(user).bridge(amount, user.address);
      await srcBridge.connect(user).bridge(amount, relayer.address);

      await relayDirection({
        name: "D",
        stateKey: "sepolia",
        srcBridge: srcBridgeRead,
        dstBridge: dstBridgeWrite,
        state,
        stateFile,
        treeDir,
      });

      for (const [nonce, recipient] of [[0, other], [1, user], [2, relayer]]) {
        const { proof, root } = getProofFromFile(path.join(treeDir, "merkle-tree-D.json"), nonce);
        await dstBridge.connect(recipient).claim(proof, root, recipient.address, amount, nonce);
      }

      expect(await dstToken.balanceOf(other.address)).to.equal(amount);
      expect(await dstToken.balanceOf(user.address)).to.equal(amount);
      expect(await dstToken.balanceOf(relayer.address)).to.equal(amount);
    });

    it("second relay poll carries forward unclaimed entries from first poll", async function () {
      const amount = ethers.parseEther("50");

      // Poll 1: bridge nonce 0
      await srcToken.connect(user).approve(await srcBridge.getAddress(), amount);
      await srcBridge.connect(user).bridge(amount, other.address);
      await relayDirection({
        name: "E",
        stateKey: "sepolia",
        srcBridge: srcBridgeRead,
        dstBridge: dstBridgeWrite,
        state,
        stateFile,
        treeDir,
      });

      // Poll 2: bridge nonce 1 (nonce 0 not yet claimed)
      await srcToken.connect(user).approve(await srcBridge.getAddress(), amount);
      await srcBridge.connect(user).bridge(amount, user.address);
      await relayDirection({
        name: "E",
        stateKey: "sepolia",
        srcBridge: srcBridgeRead,
        dstBridge: dstBridgeWrite,
        state,
        stateFile,
        treeDir,
      });

      // Both nonces must be provable from the tree after poll 2
      const { proof: proof0, root: root0 } = getProofFromFile(path.join(treeDir, "merkle-tree-E.json"), 0);
      const { proof: proof1, root: root1 } = getProofFromFile(path.join(treeDir, "merkle-tree-E.json"), 1);

      await dstBridge.connect(other).claim(proof0, root0, other.address, amount, 0n);
      await dstBridge.connect(user).claim(proof1, root1, user.address, amount, 1n);
    });
  });
});
