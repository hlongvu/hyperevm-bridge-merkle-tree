# HyperEVM Bridge (PROOF OF CONCEPT)

A bidirectional ERC20 bridge between **Sepolia** and **[HyperEVM](https://hyperliquid.gitbook.io/hyperliquid-docs/hyperevm)** testnet, using a **Lock & Mint** pattern with a **Merkle tree relayer**.

## Overview

```
Sepolia (LOCK mode)           Off-chain Relayer            HyperEVM (MINT mode)
────────────────────          ─────────────────            ────────────────────
BridgeToken (real asset)      Node.js service              BridgeToken (wrapped)
Bridge.sol                    polls events                 Bridge.sol
  bridge() → locks tokens     builds Merkle tree           claim() → mints tokens
                              posts root on-chain
```

Users lock or burn tokens on one chain, the relayer batches the transfers into a Merkle tree and posts its root, then users claim on the destination chain by submitting a Merkle proof.

---

## HyperEVM

[HyperEVM](https://hyperliquid.gitbook.io/hyperliquid-docs/hyperevm) is an EVM-compatible chain built into Hyperliquid L1. It runs alongside the Hyperliquid order book and is fully EVM-compatible, so standard Solidity contracts and Hardhat tooling work out of the box.

| Property | Value |
|---|---|
| Chain ID | `998` (testnet) |
| RPC URL | `https://rpc.hyperliquid-testnet.xyz/evm` |
| Token role in this bridge | Wrapped (MINT mode) |

HyperEVM is configured as the **MINT** side of this bridge — the `Bridge` contract mints wrapped tokens when users claim inbound transfers, and burns them when users initiate outbound transfers back to Sepolia.

---

## How the Merkle Tree Works

Instead of the relayer signing individual transfer messages, it accumulates `BridgeInitiated` events into an **append-only Merkle tree** and periodically posts the root on-chain.

### Leaf encoding

Each leaf represents one transfer and is encoded identically on-chain and off-chain:

```
leaf = keccak256(abi.encodePacked(recipient, amount, nonce))
```

This matches OpenZeppelin's `MerkleProof.verify()` expectation on the contract side, and `merkletreejs` with `{ sortPairs: true }` on the relayer side.

### Relayer flow

```
1. Poll BridgeInitiated events on source chain (500 blocks per window)
2. Load existing tree from merkle-tree-<direction>.json (if any)
3. Append new leaves (one per event)
4. Compute new Merkle root
5. Persist updated tree + full entry list to disk
6. Call setMerkleRoot(root) on destination Bridge contract
```

The tree is **append-only** — old leaves are never removed, so previously unclaimed transfers remain provable even after new batches are added.

### Claim flow

```
1. User calls get-proof.js <direction> <nonce>
   → outputs { recipient, amount, nonce, proof, merkleRoot }

2. User calls Bridge.claim(proof, recipient, amount, nonce) on destination chain
   → contract verifies: MerkleProof.verify(proof, merkleRoot, leaf)
   → marks nonce as processed (replay protection)
   → releases tokens (unlock or mint)
```

### Replay protection

`processedNonces[nonce]` is set to `true` on first successful claim. Each nonce is unique per bridge direction because `outboundNonce` increments monotonically on the source chain.

---

## Contracts

Both contracts are deployed on **both chains**. Behavior differs only by the `mode` set at deploy time.

### `BridgeToken.sol`

Standard ERC20 with bridge-controlled mint/burn.

| Function | Access | Description |
|---|---|---|
| `mint(address, amount)` | bridge only | Mint tokens to address |
| `burn(address, amount)` | bridge only | Burn tokens from address |
| `faucet()` | anyone | Mint 200 test tokens (Sepolia only) |

### `Bridge.sol`

| Function | Description |
|---|---|
| `bridge(amount, recipient)` | Lock (LOCK mode) or burn (MINT mode) tokens; emits `BridgeInitiated` |
| `setMerkleRoot(root)` | Relayer-only; updates the current Merkle root |
| `claim(proof, recipient, amount, nonce)` | Verify proof and release tokens to recipient |

**Mode behavior:**

| | LOCK (Sepolia) | MINT (HyperEVM) |
|---|---|---|
| `bridge()` | `transferFrom` user → escrow | `token.burn(user)` |
| `claim()` | `transfer` escrow → recipient | `token.mint(recipient)` |

**Constructor:**
```solidity
Bridge(
  address token,       // BridgeToken on this chain
  address relayer,     // trusted relayer address
  uint256 destChainId, // chain ID of the other chain
  Mode mode            // LOCK or MINT
)
```

---

## Project Structure

```
hyperevm-bridge/
├── contracts/
│   ├── Bridge.sol              # Core bridge logic (LOCK / MINT mode)
│   └── BridgeToken.sol         # ERC20 with mint/burn/faucet
├── ignition/modules/
│   ├── BridgeSepolia.js        # Hardhat Ignition deploy — Sepolia (LOCK)
│   └── BridgeHyperEVM.js       # Hardhat Ignition deploy — HyperEVM (MINT)
├── relayer/
│   ├── index.js                # Entry point — poll loop for both directions
│   ├── relay.js                # Core logic: event scanning, Merkle tree, setMerkleRoot
│   ├── get-proof.js            # CLI: generate a claim proof for a given nonce
│   ├── state.json              # Auto-generated: last processed block per chain
│   └── merkle-tree-*.json      # Auto-generated: persisted Merkle tree per direction
├── scripts/
│   └── verify-setup.js         # Read deployments, log config, sanity check
├── deployments/
│   ├── sepolia.json            # Auto-generated: bridge + token addresses
│   └── hyperevm.json           # Auto-generated: bridge + token addresses
├── test/
│   └── bridge.test.js          # Unit tests (Hardhat local network)
├── hardhat.config.js
└── .env
```

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in:

| Variable | Description |
|---|---|
| `DEPLOYER_PRIVATE_KEY` | Wallet that deploys contracts (needs gas on both chains) |
| `RELAYER_PRIVATE_KEY` | Wallet the relayer uses to post Merkle roots |
| `SEPOLIA_RPC_URL` | Alchemy / Infura / public Sepolia endpoint |
| `HYPEREVM_RPC_URL` | `https://rpc.hyperliquid-testnet.xyz/evm` (default) |

Fund both wallets with testnet ETH:
- **Sepolia** — [sepoliafaucet.com](https://sepoliafaucet.com) or Alchemy faucet
- **HyperEVM** — Hyperliquid testnet Discord faucet

### 3. Test

```bash
npm test
```

### 4. Deploy

```bash
npm run deploy:sepolia
npm run deploy:hyperevm
npm run verify:setup
```

Deployment addresses are written to `deployments/sepolia.json` and `deployments/hyperevm.json`.

---

## Running the Relayer

```bash
npm run relayer
```

The relayer polls both chains every 12 seconds. On each poll:
- Scans up to 500 new blocks for `BridgeInitiated` events
- If events found: appends leaves to the Merkle tree and calls `setMerkleRoot()` on destination
- Persists last-processed block to `relayer/state.json`

---

## Claiming Tokens

After the relayer has posted a root that includes your transfer:

**1. Get your proof:**
```bash
npm run get-proof -- Sepolia_HyperEVM <nonce>
# or
npm run get-proof -- HyperEVM_Sepolia <nonce>
```

Output:
```json
{
  "recipient": "0x...",
  "amount": "50000000000000000000",
  "nonce": "0",
  "proof": ["0x...", "0x..."],
  "merkleRoot": "0x..."
}
```

**2. Call `Bridge.claim()` on the destination chain** with the proof values.

The `nonce` comes from the `BridgeInitiated` event on the source chain. Each nonce can only be claimed once.

---

## Chain Configuration

| | Sepolia | HyperEVM Testnet |
|---|---|---|
| Chain ID | `11155111` | `998` |
| Bridge mode | `LOCK` | `MINT` |
| Token role | Native (real asset) | Wrapped |
| Faucet | `BridgeToken.faucet()` | — |

---

## Security Notes

- The relayer is **trusted** — it can post any Merkle root, so a compromised key is a risk
- Nonces are globally unique per direction and single-use (replay protection)
- For production: replace the trusted relayer with a light-client verifier or ZK proof
