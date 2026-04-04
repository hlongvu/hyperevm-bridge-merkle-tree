// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./BridgeToken.sol";

/**
 * @title Bridge
 * @notice Bidirectional ERC20 bridge using Lock & Mint pattern with a trusted relayer.
 *
 *   LOCK mode (Sepolia):   bridge() locks tokens in escrow, release() unlocks from escrow.
 *   MINT mode (HyperEVM):  bridge() burns tokens,          release() mints tokens.
 *
 * Signature scheme (relayer signs before calling release):
 *   keccak256(abi.encodePacked(destChainId, recipient, amount, nonce))
 */
contract Bridge {
    using ECDSA for bytes32;

    enum Mode { LOCK, MINT }

    BridgeToken public immutable token;
    address public immutable relayer;
    uint256 public immutable destChainId;
    Mode public immutable mode;

    uint256 public outboundNonce;

    /// @notice Tracks inbound nonces already processed to prevent replay attacks.
    mapping(uint256 => bool) public processedNonces;

    event BridgeInitiated(
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        uint256 nonce
    );

    event BridgeReleased(
        address indexed recipient,
        uint256 amount,
        uint256 nonce
    );

    constructor(
        address _token,
        address _relayer,
        uint256 _destChainId,
        Mode _mode
    ) {
        token = BridgeToken(_token);
        relayer = _relayer;
        destChainId = _destChainId;
        mode = _mode;
    }

    /**
     * @notice Initiate a bridge transfer to the destination chain.
     * @param amount    Amount of tokens to bridge.
     * @param recipient Address on the destination chain to receive tokens.
     */
    function bridge(uint256 amount, address recipient) external {
        require(amount > 0, "Bridge: amount must be > 0");
        require(recipient != address(0), "Bridge: invalid recipient");

        uint256 nonce = outboundNonce++;

        if (mode == Mode.LOCK) {
            // Transfer tokens from user into this contract (escrow)
            require(
                token.transferFrom(msg.sender, address(this), amount),
                "Bridge: transferFrom failed"
            );
        } else {
            // Burn tokens from user
            token.burn(msg.sender, amount);
        }

        emit BridgeInitiated(msg.sender, recipient, amount, nonce);
    }

    /**
     * @notice Release tokens to recipient. Called by the relayer after verifying
     *         a BridgeInitiated event on the source chain.
     * @param recipient Address to receive tokens on this chain.
     * @param amount    Amount of tokens to release.
     * @param nonce     Outbound nonce from the source chain event.
     * @param sig       Relayer's ECDSA signature over (destChainId, recipient, amount, nonce).
     */
    function release(
        address recipient,
        uint256 amount,
        uint256 nonce,
        bytes calldata sig
    ) external {
        require(!processedNonces[nonce], "Bridge: nonce already processed");
        require(recipient != address(0), "Bridge: invalid recipient");
        require(amount > 0, "Bridge: amount must be > 0");

        // Verify signature — bind to this chain's ID to prevent cross-chain replay
        bytes32 hash = keccak256(abi.encodePacked(block.chainid, recipient, amount, nonce));
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(hash);
        address signer = ethHash.recover(sig);
        require(signer == relayer, "Bridge: invalid relayer signature");

        processedNonces[nonce] = true;

        if (mode == Mode.LOCK) {
            // Transfer tokens out of escrow
            require(token.transfer(recipient, amount), "Bridge: transfer failed");
        } else {
            // Mint tokens to recipient
            token.mint(recipient, amount);
        }

        emit BridgeReleased(recipient, amount, nonce);
    }
}
