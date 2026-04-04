# ERC20 Bridge: Sepolia ↔ HyperEVM Testnet

## Overview

A bidirectional ERC20 token bridge using a **Lock & Mint** pattern with a **trusted relayer**.

- **Sepolia** is the origin chain — holds the real asset
- **HyperEVM** is the wrapped chain — holds the wrapped representation

---

## Architecture

```
Sepolia (Origin)               Relayer (off-chain)         HyperEVM (Wrapped)
──────────────────             ──────────────────           ──────────────────
BridgeToken.sol                  Node.js service            BridgeToken.sol
(real token, faucet here)        listens + signs            (wrapped token)

Bridge.sol                                                  Bridge.sol
mode = LOCK                                                 mode = MINT
(lock / unlock)                                             (mint / burn)
```

### Direction A — Sepolia → HyperEVM

1. User calls `Bridge.bridge(amount, recipient)` on Sepolia
2. Bridge locks real tokens in escrow, emits `BridgeInitiated`
3. Relayer picks up event, signs `(destChainId, recipient, amount, nonce)`
4. Relayer calls `Bridge.release(recipient, amount, nonce, sig)` on HyperEVM
5. HyperEVM bridge verifies signature, mints wrapped tokens to recipient

### Direction B — HyperEVM → Sepolia

1. User calls `Bridge.bridge(amount, recipient)` on HyperEVM
2. Bridge burns wrapped tokens, emits `BridgeInitiated`
3. Relayer picks up event, signs `(destChainId, recipient, amount, nonce)`
4. Relayer calls `Bridge.release(recipient, amount, nonce, sig)` on Sepolia
5. Sepolia bridge verifies signature, unlocks real tokens to recipient

---

## Contracts (2 total, deployed on both chains)

### `BridgeToken.sol`

Standard ERC20 with bridge-controlled mint/burn.

| Function | Access | Description |
|---|---|---|
| `mint(address, amount)` | bridge only | Mint tokens to address |
| `burn(address, amount)` | bridge only | Burn tokens from address |
| `setBridge(address)` | owner only | Set the authorized bridge contract |
| `faucet()` | anyone | Mint 200 test tokens — **Sepolia only** |

> On HyperEVM, `faucet()` is disabled (or not callable since bridge controls mint).

---

### `Bridge.sol`

Same contract deployed on both chains. Behavior is determined by `mode` set at deploy time.

| Property | LOCK mode (Sepolia) | MINT mode (HyperEVM) |
|---|---|---|
| `bridge()` | Transfers tokens from user into escrow | Burns tokens from user via `token.burn()` |
| `release()` | Transfers tokens out of escrow to recipient | Mints tokens to recipient via `token.mint()` |

**Constructor parameters:**
```
Bridge(
  address token,       // BridgeToken address on this chain
  address relayer,     // trusted relayer address
  uint256 destChainId, // chain ID of the other chain
  Mode mode            // LOCK or MINT
)
```

**Signature scheme** — relayer signs this hash before calling `release()`:
```
keccak256(abi.encodePacked(destChainId, recipient, amount, nonce))
```
This binds the signature to a specific chain, recipient, amount, and one-time nonce — preventing replay attacks.

**Key state:**
- `outboundNonce` — increments per `bridge()` call, included in event
- `processedNonces` mapping — tracks which inbound nonces are already handled

---

## Chain Configuration

| Property | Sepolia | HyperEVM Testnet |
|---|---|---|
| Chain ID | `11155111` | `998` |
| RPC URL | Alchemy / Infura / public | `https://rpc.hyperliquid-testnet.xyz/evm` |
| Bridge mode | `LOCK` | `MINT` |
| Token role | Native (real asset) | Wrapped |
| Faucet | ✅ on BridgeToken | ❌ |

---

## Project Structure

```
evm-bridge/
├── contracts/
│   ├── BridgeToken.sol         # ERC20 — deployed on both chains
│   └── Bridge.sol              # Bridge logic — deployed on both chains
├── scripts/
│   ├── deploy-sepolia.js       # Deploy BridgeToken + Bridge(LOCK) on Sepolia
│   ├── deploy-hyperevm.js      # Deploy BridgeToken + Bridge(MINT) on HyperEVM
│   └── verify-setup.js         # Read deployments, log config, sanity check
├── relayer/
│   └── index.js                # Off-chain relayer service
├── deployments/
│   ├── sepolia.json            # Auto-generated: token + bridge addresses
│   └── hyperevm.json           # Auto-generated: token + bridge addresses
├── test/
│   └── bridge.test.js          # Unit tests on local Hardhat fork
├── hardhat.config.js
├── .env.example
├── PLAN.md
└── README.md
```

---

## Phase Plan

### Phase 1 — Environment Setup

- [ ] Install Node.js + Hardhat
- [ ] Copy `.env.example` to `.env`, fill in:
  - `DEPLOYER_PRIVATE_KEY` — wallet that deploys contracts (needs gas on both chains)
  - `RELAYER_PRIVATE_KEY` — separate wallet the relayer uses to sign + submit txs (needs gas on both chains)
  - `SEPOLIA_RPC_URL` — Alchemy or Infura endpoint
  - `HYPEREVM_RPC_URL` — `https://rpc.hyperliquid-testnet.xyz/evm`
- [ ] Fund deployer + relayer wallets with testnet ETH:
  - Sepolia: [sepoliafaucet.com](https://sepoliafaucet.com) or Alchemy faucet
  - HyperEVM: Hyperliquid testnet Discord faucet

### Phase 2 — Contracts

- [ ] Write `BridgeToken.sol`
- [ ] Write `Bridge.sol` with `LOCK` / `MINT` mode enum
- [ ] Write unit tests in `test/bridge.test.js` using Hardhat local network
- [ ] Run `npx hardhat test` — all passing

### Phase 3 — Deployment

- [ ] Run `deploy-sepolia.js` → outputs `deployments/sepolia.json`
- [ ] Run `deploy-hyperevm.js` → outputs `deployments/hyperevm.json`
- [ ] Run `verify-setup.js` → confirms addresses + relayer config on both chains

### Phase 4 — Relayer

- [ ] Write `relayer/index.js`:
  - Connect to both chains via ethers.js v6
  - Poll for `BridgeInitiated` events on both chains by block range
  - Sign payload with relayer private key
  - Submit `release()` transaction on destination chain
  - Persist last processed block to `relayer/state.json`
  - Retry on failure, log all activity

### Phase 5 — End-to-End Test

- [ ] Call `BridgeToken.faucet()` on Sepolia → receive 200 TTK
- [ ] Approve + call `Bridge.bridge(50, myHyperEVMAddress)` on Sepolia
- [ ] Watch relayer logs — event should be picked up
- [ ] Check `BridgeToken.balanceOf(myHyperEVMAddress)` on HyperEVM → expect 50 wTTK
- [ ] Approve + call `Bridge.bridge(20, mySepoliaAddress)` on HyperEVM
- [ ] Check `BridgeToken.balanceOf(mySepoliaAddress)` on Sepolia → expect +20 TTK unlocked

---

## Security Notes

- The relayer is **trusted** — a compromised relayer key can mint unbacked wrapped tokens
- Nonce tracking prevents replay attacks within a chain pair
- Signature binds to `destChainId` — a signature valid on HyperEVM is not valid on any other chain
- For production: replace trusted relayer with a Merkle proof / light client verifier

---

## Optional Enhancements (post-MVP)

| Feature | Description |
|---|---|
| Bridge fee | Deduct small % on `bridge()`, accumulate in contract |
| Daily limit | Cap total bridgeable amount per 24h window |
| Multi-token | Map multiple ERC20s in one Bridge contract |
| WebSocket relayer | Event-driven instead of block polling |
| Frontend UI | React + wagmi + viem wallet interface |
| Merkle relayer | Trustless — no relayer signature, prove tx inclusion |
