import { expect } from "chai";
import { network } from "hardhat";

const LOCK = 0;
const MINT = 1;

// In Hardhat 3, ethers is accessed via the network connection
const { ethers } = await network.connect();

// Hardhat local network chainId — contracts use block.chainid in signature
const CHAIN_ID = 31337n;

describe("Bridge", function () {
  let relayer, user, other;
  let sepoliaToken, hyperevmToken;
  let sepoliaBridge, hyperevmBridge;

  beforeEach(async function () {
    [, relayer, user, other] = await ethers.getSigners();

    const BridgeToken = await ethers.getContractFactory("BridgeToken");
    const Bridge = await ethers.getContractFactory("Bridge");

    // Sepolia side: real token, LOCK mode
    // destChainId arg (998) is stored but not used in signature — block.chainid is used instead
    sepoliaToken = await BridgeToken.deploy("Test Token", "TTK", true);
    sepoliaBridge = await Bridge.deploy(
      await sepoliaToken.getAddress(),
      relayer.address,
      998n, // destChainId = HyperEVM (stored for reference, not used in sig)
      LOCK
    );
    await sepoliaToken.setBridge(await sepoliaBridge.getAddress());

    // HyperEVM side: wrapped token, MINT mode
    hyperevmToken = await BridgeToken.deploy("Wrapped Test Token", "wTTK", false);
    hyperevmBridge = await Bridge.deploy(
      await hyperevmToken.getAddress(),
      relayer.address,
      11155111n, // destChainId = Sepolia (stored for reference, not used in sig)
      MINT
    );
    await hyperevmToken.setBridge(await hyperevmBridge.getAddress());

    // Give user some tokens via faucet
    await sepoliaToken.connect(user).faucet();
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  // The contract uses block.chainid in the sig hash, so both bridges share the
  // same chainId (31337) in tests.
  async function signRelease(wallet, recipient, amount, nonce) {
    const hash = ethers.solidityPackedKeccak256(
      ["uint256", "address", "uint256", "uint256"],
      [CHAIN_ID, recipient, amount, nonce]
    );
    return wallet.signMessage(ethers.getBytes(hash));
  }

  // ─── BridgeToken ───────────────────────────────────────────────────────────

  describe("BridgeToken", function () {
    it("mints 200 tokens via faucet", async function () {
      const balance = await sepoliaToken.balanceOf(user.address);
      expect(balance).to.equal(ethers.parseEther("200"));
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

    it("relayer can mint on HyperEVM after locking on Sepolia", async function () {
      const tx = await sepoliaBridge.connect(user).bridge(amount, other.address);
      const receipt = await tx.wait();
      const event = receipt.logs.find((l) => {
        try { return sepoliaBridge.interface.parseLog(l).name === "BridgeInitiated"; } catch { return false; }
      });
      const parsed = sepoliaBridge.interface.parseLog(event);
      const nonce = parsed.args.nonce;

      const sig = await signRelease(relayer, other.address, amount, nonce);

      await expect(
        hyperevmBridge.connect(relayer).release(other.address, amount, nonce, sig)
      )
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
      const smallAmount = ethers.parseEther("10");
      await sepoliaToken.connect(user).approve(await sepoliaBridge.getAddress(), smallAmount * 3n);

      for (let i = 0; i < 3; i++) {
        const tx = await sepoliaBridge.connect(user).bridge(smallAmount, other.address);
        const receipt = await tx.wait();
        const event = receipt.logs.find((l) => {
          try { return sepoliaBridge.interface.parseLog(l).name === "BridgeInitiated"; } catch { return false; }
        });
        const parsed = sepoliaBridge.interface.parseLog(event);
        expect(parsed.args.nonce).to.equal(BigInt(i));
      }
    });
  });

  // ─── Direction B: HyperEVM → Sepolia ──────────────────────────────────────

  describe("Direction B: HyperEVM → Sepolia (MINT → LOCK)", function () {
    const lockAmount = ethers.parseEther("50");
    const burnAmount = ethers.parseEther("20");

    beforeEach(async function () {
      // First bridge Sepolia→HyperEVM so user has wTTK
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

      const userBalanceBefore = await sepoliaToken.balanceOf(user.address);

      const sig = await signRelease(relayer, user.address, burnAmount, 0n);
      await sepoliaBridge.connect(relayer).release(user.address, burnAmount, 0n, sig);

      expect(await sepoliaToken.balanceOf(user.address)).to.equal(
        userBalanceBefore + burnAmount
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
