import { expect } from "chai";
import { network } from "hardhat";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import BridgeSepoliaModule from "../ignition/modules/BridgeSepolia.js";
import BridgeHyperEVMModule from "../ignition/modules/BridgeHyperEVM.js";

// In Hardhat 3, ethers and ignition are accessed via the network connection
const connection = await network.connect();
const { ethers, ignition } = connection;

// ─── Fixture ─────────────────────────────────────────────────────────────────

/**
 * Deploy both bridge sides using Ignition modules.
 * Each call to this function redeploys fresh contracts (unique deploymentId per run).
 */
async function deployBridge(relayerAddress, deploymentId) {
  const params = { relayer: relayerAddress };

  const { token: sepoliaToken, bridge: sepoliaBridge } = await ignition.deploy(
    BridgeSepoliaModule,
    { parameters: { BridgeSepolia: params }, deploymentId: `sepolia-${deploymentId}` }
  );

  const { token: hyperevmToken, bridge: hyperevmBridge } = await ignition.deploy(
    BridgeHyperEVMModule,
    { parameters: { BridgeHyperEVM: params }, deploymentId: `hyperevm-${deploymentId}` }
  );

  return { sepoliaToken, sepoliaBridge, hyperevmToken, hyperevmBridge };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a StandardMerkleTree from [recipient, amount, nonce] entries.
 * Types must match the on-chain leaf encoding: (address, uint256, uint256).
 */
function buildMerkleTree(entries) {
  const tree = StandardMerkleTree.of(
    entries.map(([r, a, n]) => [r, a.toString(), n.toString()]),
    ["address", "uint256", "uint256"]
  );
  return { tree, root: tree.root };
}

/**
 * Get the proof for a specific nonce from a tree.
 */
function getMerkleProof(tree, nonce) {
  const targetNonce = BigInt(nonce).toString();
  for (const [i, [, , n]] of tree.entries()) {
    if (n === targetNonce) return tree.getProof(i);
  }
  throw new Error(`Nonce ${nonce} not found in tree`);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Bridge", function () {
  let relayer, user, other;
  let sepoliaToken, hyperevmToken;
  let sepoliaBridge, hyperevmBridge;
  let deployCount = 0;

  beforeEach(async function () {
    [, relayer, user, other] = await ethers.getSigners();

    ({ sepoliaToken, sepoliaBridge, hyperevmToken, hyperevmBridge } =
      await deployBridge(relayer.address, deployCount++));

    // Give user some tokens via faucet
    await sepoliaToken.connect(user).faucet();
  });

  // ─── BridgeToken ───────────────────────────────────────────────────────────

  describe("BridgeToken", function () {
    it("mints 200 tokens via faucet", async function () {
      expect(await sepoliaToken.balanceOf(user.address)).to.equal(
        ethers.parseEther("200")
      );
    });

    it("faucet reverts when disabled", async function () {
      await expect(hyperevmToken.connect(user).faucet()).to.be.revertedWith(
        "BridgeToken: faucet not enabled"
      );
    });

    it("only bridge can mint", async function () {
      await expect(
        sepoliaToken.connect(other).mint(other.address, 1)
      ).to.be.revertedWith("BridgeToken: caller is not the bridge");
    });

    it("only bridge can burn", async function () {
      await expect(
        sepoliaToken.connect(other).burn(user.address, 1)
      ).to.be.revertedWith("BridgeToken: caller is not the bridge");
    });

    it("only owner can setBridge", async function () {
      await expect(
        sepoliaToken.connect(other).setBridge(other.address)
      ).to.be.revert(ethers);
    });

    it("ignition wired setBridge correctly", async function () {
      expect(await sepoliaToken.bridge()).to.equal(
        await sepoliaBridge.getAddress()
      );
      expect(await hyperevmToken.bridge()).to.equal(
        await hyperevmBridge.getAddress()
      );
    });
  });

  // ─── bridge() ──────────────────────────────────────────────────────────────

  describe("bridge()", function () {
    const amount = ethers.parseEther("50");

    beforeEach(async function () {
      await sepoliaToken.connect(user).approve(await sepoliaBridge.getAddress(), amount);
    });

    it("locks tokens on Sepolia and emits BridgeInitiated", async function () {
      const bridgeAddr = await sepoliaBridge.getAddress();
      await expect(sepoliaBridge.connect(user).bridge(amount, other.address))
        .to.emit(sepoliaBridge, "BridgeInitiated")
        .withArgs(user.address, other.address, amount, 0n);

      expect(await sepoliaToken.balanceOf(bridgeAddr)).to.equal(amount);
      expect(await sepoliaToken.balanceOf(user.address)).to.equal(
        ethers.parseEther("150")
      );
    });

    it("burns tokens on HyperEVM (MINT mode) and emits BridgeInitiated", async function () {
      // Give user wTTK by minting directly (only bridge can mint; simulate via claim)
      const { tree, root } = buildMerkleTree([[user.address, amount, 0n]]);
      await hyperevmBridge.connect(relayer).setMerkleRoot(root);
      const proof = getMerkleProof(tree, 0n);
      await hyperevmBridge.connect(user).claim(proof, user.address, amount, 0n);

      await hyperevmToken.connect(user).approve(await hyperevmBridge.getAddress(), amount);
      await expect(hyperevmBridge.connect(user).bridge(amount, user.address))
        .to.emit(hyperevmBridge, "BridgeInitiated")
        .withArgs(user.address, user.address, amount, 0n);

      expect(await hyperevmToken.balanceOf(user.address)).to.equal(0n);
    });

    it("nonce increments per bridge() call", async function () {
      const small = ethers.parseEther("10");
      await sepoliaToken.connect(user).approve(await sepoliaBridge.getAddress(), small * 3n);

      for (let i = 0; i < 3; i++) {
        const tx = await sepoliaBridge.connect(user).bridge(small, other.address);
        const receipt = await tx.wait();
        const event = receipt.logs.find((l) => {
          try { return sepoliaBridge.interface.parseLog(l).name === "BridgeInitiated"; } catch { return false; }
        });
        const { nonce } = sepoliaBridge.interface.parseLog(event).args;
        expect(nonce).to.equal(BigInt(i));
      }
    });

    it("reverts with amount=0", async function () {
      await expect(
        sepoliaBridge.connect(user).bridge(0, other.address)
      ).to.be.revertedWith("Bridge: amount must be > 0");
    });

    it("reverts with zero recipient", async function () {
      await expect(
        sepoliaBridge.connect(user).bridge(100n, ethers.ZeroAddress)
      ).to.be.revertedWith("Bridge: invalid recipient");
    });
  });

  // ─── Merkle Claim ──────────────────────────────────────────────────────────

  describe("Merkle Claim", function () {
    const amount = ethers.parseEther("50");

    beforeEach(async function () {
      // Bridge tokens so nonce 0 exists on the source chain
      await sepoliaToken.connect(user).approve(await sepoliaBridge.getAddress(), amount);
      await sepoliaBridge.connect(user).bridge(amount, other.address);
    });

    it("relayer can set merkle root", async function () {
      const { root } = buildMerkleTree([[other.address, amount, 0n]]);
      await expect(hyperevmBridge.connect(relayer).setMerkleRoot(root))
        .to.emit(hyperevmBridge, "MerkleRootUpdated")
        .withArgs(root);
      expect(await hyperevmBridge.merkleRoot()).to.equal(root);
    });

    it("non-relayer cannot set merkle root", async function () {
      const { root } = buildMerkleTree([[other.address, amount, 0n]]);
      await expect(
        hyperevmBridge.connect(user).setMerkleRoot(root)
      ).to.be.revertedWith("Bridge: caller is not relayer");
    });

    it("setMerkleRoot reverts with zero root", async function () {
      await expect(
        hyperevmBridge.connect(relayer).setMerkleRoot(ethers.ZeroHash)
      ).to.be.revertedWith("Bridge: root cannot be zero");
    });

    it("user can claim with valid proof (MINT mode)", async function () {
      const { tree, root } = buildMerkleTree([[other.address, amount, 0n]]);
      await hyperevmBridge.connect(relayer).setMerkleRoot(root);

      const proof = getMerkleProof(tree, 0n);
      await expect(
        hyperevmBridge.connect(other).claim(proof, other.address, amount, 0n)
      )
        .to.emit(hyperevmBridge, "BridgeClaimed")
        .withArgs(other.address, amount, 0n);

      expect(await hyperevmToken.balanceOf(other.address)).to.equal(amount);
    });

    it("claim marks nonce as processed", async function () {
      const { tree, root } = buildMerkleTree([[other.address, amount, 0n]]);
      await hyperevmBridge.connect(relayer).setMerkleRoot(root);
      const proof = getMerkleProof(tree, 0n);
      await hyperevmBridge.connect(other).claim(proof, other.address, amount, 0n);

      expect(await hyperevmBridge.processedNonces(0n)).to.equal(true);
    });

    it("cannot claim twice (replay protection)", async function () {
      const { tree, root } = buildMerkleTree([[other.address, amount, 0n]]);
      await hyperevmBridge.connect(relayer).setMerkleRoot(root);
      const proof = getMerkleProof(tree, 0n);
      await hyperevmBridge.connect(other).claim(proof, other.address, amount, 0n);

      await expect(
        hyperevmBridge.connect(other).claim(proof, other.address, amount, 0n)
      ).to.be.revertedWith("Bridge: nonce already processed");
    });

    it("claim reverts with wrong amount in proof", async function () {
      const wrongAmount = ethers.parseEther("99");
      const { tree, root } = buildMerkleTree([[other.address, wrongAmount, 0n]]);
      await hyperevmBridge.connect(relayer).setMerkleRoot(root);
      const proof = getMerkleProof(tree, 0n);

      // proof is for wrongAmount but we submit the real amount — leaf mismatch
      await expect(
        hyperevmBridge.connect(other).claim(proof, other.address, amount, 0n)
      ).to.be.revertedWith("Bridge: invalid merkle proof");
    });

    it("claim reverts when no root is set", async function () {
      await expect(
        hyperevmBridge.connect(other).claim([], other.address, amount, 0n)
      ).to.be.revertedWith("Bridge: no merkle root set");
    });

    it("claim() reverts with zero recipient", async function () {
      const { root } = buildMerkleTree([[other.address, amount, 0n]]);
      await hyperevmBridge.connect(relayer).setMerkleRoot(root);
      await expect(
        hyperevmBridge.connect(user).claim([], ethers.ZeroAddress, 100n, 0n)
      ).to.be.revertedWith("Bridge: invalid recipient");
    });

    it("claim() reverts with zero amount", async function () {
      const { root } = buildMerkleTree([[other.address, amount, 0n]]);
      await hyperevmBridge.connect(relayer).setMerkleRoot(root);
      await expect(
        hyperevmBridge.connect(user).claim([], other.address, 0n, 0n)
      ).to.be.revertedWith("Bridge: amount must be > 0");
    });

    it("multi-leaf tree: each leaf claimable independently", async function () {
      const amount2 = ethers.parseEther("30");
      await sepoliaToken.connect(user).approve(await sepoliaBridge.getAddress(), amount2);
      await sepoliaBridge.connect(user).bridge(amount2, user.address);

      const { tree, root } = buildMerkleTree([
        [other.address, amount, 0n],
        [user.address, amount2, 1n],
      ]);
      await hyperevmBridge.connect(relayer).setMerkleRoot(root);

      const proof0 = getMerkleProof(tree, 0n);
      await hyperevmBridge.connect(other).claim(proof0, other.address, amount, 0n);
      expect(await hyperevmBridge.processedNonces(1n)).to.equal(false);

      const proof1 = getMerkleProof(tree, 1n);
      await hyperevmBridge.connect(user).claim(proof1, user.address, amount2, 1n);
      expect(await hyperevmToken.balanceOf(user.address)).to.equal(amount2);
    });

    it("LOCK mode: claim unlocks tokens from escrow (Sepolia)", async function () {
      // Tokens are locked in Sepolia bridge from beforeEach bridge() call
      const { tree, root } = buildMerkleTree([[other.address, amount, 0n]]);
      await sepoliaBridge.connect(relayer).setMerkleRoot(root);

      const balBefore = await sepoliaToken.balanceOf(other.address);
      const proof = getMerkleProof(tree, 0n);
      await sepoliaBridge.connect(other).claim(proof, other.address, amount, 0n);
      expect(await sepoliaToken.balanceOf(other.address)).to.equal(balBefore + amount);
    });
  });
});
