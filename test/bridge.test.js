import { expect } from "chai";
import { network } from "hardhat";
import BridgeSepoliaModule from "../ignition/modules/BridgeSepolia.js";
import BridgeHyperEVMModule from "../ignition/modules/BridgeHyperEVM.js";

// In Hardhat 3, ethers and ignition are accessed via the network connection
const connection = await network.connect();
const { ethers, ignition } = connection;

// Hardhat local network chainId — Bridge.sol uses block.chainid in signature hash
const CHAIN_ID = 31337n;

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

async function signRelease(wallet, recipient, amount, nonce) {
  const hash = ethers.solidityPackedKeccak256(
    ["uint256", "address", "uint256", "uint256"],
    [CHAIN_ID, recipient, amount, nonce]
  );
  return wallet.signMessage(ethers.getBytes(hash));
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

  // ─── Direction A: Sepolia → HyperEVM ──────────────────────────────────────

  describe("Direction A: Sepolia → HyperEVM (LOCK → MINT)", function () {
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

    it("relayer mints on HyperEVM after locking on Sepolia", async function () {
      const tx = await sepoliaBridge.connect(user).bridge(amount, other.address);
      const receipt = await tx.wait();
      const event = receipt.logs.find((l) => {
        try { return sepoliaBridge.interface.parseLog(l).name === "BridgeInitiated"; } catch { return false; }
      });
      const { nonce } = sepoliaBridge.interface.parseLog(event).args;

      const sig = await signRelease(relayer, other.address, amount, nonce);
      await expect(hyperevmBridge.connect(relayer).release(other.address, amount, nonce, sig))
        .to.emit(hyperevmBridge, "BridgeReleased")
        .withArgs(other.address, amount, nonce);

      expect(await hyperevmToken.balanceOf(other.address)).to.equal(amount);
    });

    it("cannot replay the same nonce", async function () {
      await sepoliaBridge.connect(user).bridge(amount, other.address);
      const sig = await signRelease(relayer, other.address, amount, 0n);
      await hyperevmBridge.connect(relayer).release(other.address, amount, 0n, sig);

      await expect(
        hyperevmBridge.connect(relayer).release(other.address, amount, 0n, sig)
      ).to.be.revertedWith("Bridge: nonce already processed");
    });

    it("rejects invalid relayer signature", async function () {
      await sepoliaBridge.connect(user).bridge(amount, other.address);
      const fakeSig = await signRelease(other, other.address, amount, 0n);
      await expect(
        hyperevmBridge.connect(relayer).release(other.address, amount, 0n, fakeSig)
      ).to.be.revertedWith("Bridge: invalid relayer signature");
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
  });

  // ─── Direction B: HyperEVM → Sepolia ──────────────────────────────────────

  describe("Direction B: HyperEVM → Sepolia (MINT → LOCK)", function () {
    const lockAmount = ethers.parseEther("50");
    const burnAmount = ethers.parseEther("20");

    beforeEach(async function () {
      // Sepolia→HyperEVM first so user has wTTK to burn back
      await sepoliaToken.connect(user).approve(await sepoliaBridge.getAddress(), lockAmount);
      await sepoliaBridge.connect(user).bridge(lockAmount, user.address);
      const sig = await signRelease(relayer, user.address, lockAmount, 0n);
      await hyperevmBridge.connect(relayer).release(user.address, lockAmount, 0n, sig);
      expect(await hyperevmToken.balanceOf(user.address)).to.equal(lockAmount);
    });

    it("burns wTTK on HyperEVM and emits BridgeInitiated", async function () {
      await hyperevmToken.connect(user).approve(await hyperevmBridge.getAddress(), burnAmount);
      await expect(hyperevmBridge.connect(user).bridge(burnAmount, user.address))
        .to.emit(hyperevmBridge, "BridgeInitiated")
        .withArgs(user.address, user.address, burnAmount, 0n);

      expect(await hyperevmToken.balanceOf(user.address)).to.equal(lockAmount - burnAmount);
    });

    it("relayer unlocks TTK on Sepolia after burning wTTK", async function () {
      await hyperevmToken.connect(user).approve(await hyperevmBridge.getAddress(), burnAmount);
      await hyperevmBridge.connect(user).bridge(burnAmount, user.address);

      const balanceBefore = await sepoliaToken.balanceOf(user.address);
      const sig = await signRelease(relayer, user.address, burnAmount, 0n);
      await sepoliaBridge.connect(relayer).release(user.address, burnAmount, 0n, sig);

      expect(await sepoliaToken.balanceOf(user.address)).to.equal(
        balanceBefore + burnAmount
      );
    });
  });

  // ─── Edge cases ────────────────────────────────────────────────────────────

  describe("Edge cases", function () {
    it("bridge() reverts with amount=0", async function () {
      await expect(
        sepoliaBridge.connect(user).bridge(0, other.address)
      ).to.be.revertedWith("Bridge: amount must be > 0");
    });

    it("bridge() reverts with zero recipient", async function () {
      await sepoliaToken.connect(user).approve(await sepoliaBridge.getAddress(), 100n);
      await expect(
        sepoliaBridge.connect(user).bridge(100n, ethers.ZeroAddress)
      ).to.be.revertedWith("Bridge: invalid recipient");
    });

    it("release() reverts with zero recipient", async function () {
      const sig = await signRelease(relayer, ethers.ZeroAddress, 100n, 0n);
      await expect(
        hyperevmBridge.connect(relayer).release(ethers.ZeroAddress, 100n, 0n, sig)
      ).to.be.revertedWith("Bridge: invalid recipient");
    });
  });
});
