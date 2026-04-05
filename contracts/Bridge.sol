// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "./BridgeToken.sol";

/**
 * @title Bridge
 * @notice Bidirectional ERC20 bridge using Lock & Mint pattern with a trusted relayer.
 *
 *   LOCK mode (Sepolia):   bridge() locks tokens in escrow, claim() unlocks from escrow.
 *   MINT mode (HyperEVM):  bridge() burns tokens,          claim() mints tokens.
 *
 * The relayer batches pending transfers into a Merkle tree and posts the root via
 * setMerkleRoot(). Users then claim their funds by submitting a Merkle proof.
 */
contract Bridge {
    enum Mode { LOCK, MINT }

    BridgeToken public immutable token;
    address public immutable relayer;
    uint256 public immutable destChainId;
    Mode public immutable mode;

    uint256 public outboundNonce;

    /// @notice Tracks inbound nonces already processed to prevent replay attacks.
    mapping(uint256 => bool) public processedNonces;

    /// @notice Current Merkle root for claimable transfers. Zero means no root set.
    bytes32 public merkleRoot;

    event BridgeInitiated(
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        uint256 nonce
    );

    event MerkleRootUpdated(bytes32 indexed root);

    event BridgeClaimed(
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
     * @notice Set a new Merkle root for the current batch of claimable transfers.
     *         Only callable by the relayer.
     * @param root  keccak256 root of the StandardMerkleTree built from
     *              (address recipient, uint256 amount, uint256 nonce) leaves.
     */
    function setMerkleRoot(bytes32 root) external {
        require(msg.sender == relayer, "Bridge: caller is not relayer");
        require(root != bytes32(0), "Bridge: root cannot be zero");
        merkleRoot = root;
        emit MerkleRootUpdated(root);
    }

    /**
     * @notice Claim a bridged transfer by submitting a Merkle proof.
     *         Anyone may call this on behalf of `recipient`.
     * @param proof      Merkle proof path (from @openzeppelin/merkle-tree).
     * @param recipient  Address to receive tokens.
     * @param amount     Amount of tokens to release.
     * @param nonce      Outbound nonce from the source chain BridgeInitiated event.
     */
    function claim(
        bytes32[] calldata proof,
        address recipient,
        uint256 amount,
        uint256 nonce
    ) external {
        require(merkleRoot != bytes32(0), "Bridge: no merkle root set");
        require(!processedNonces[nonce], "Bridge: nonce already processed");
        require(recipient != address(0), "Bridge: invalid recipient");
        require(amount > 0, "Bridge: amount must be > 0");

        // Single keccak256 of encodePacked — matches merkletreejs off-chain leaf encoding
        bytes32 leaf = keccak256(abi.encodePacked(recipient, amount, nonce));
        require(MerkleProof.verify(proof, merkleRoot, leaf), "Bridge: invalid merkle proof");

        processedNonces[nonce] = true;

        if (mode == Mode.LOCK) {
            require(token.transfer(recipient, amount), "Bridge: transfer failed");
        } else {
            token.mint(recipient, amount);
        }

        emit BridgeClaimed(recipient, amount, nonce);
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
            require(
                token.transferFrom(msg.sender, address(this), amount),
                "Bridge: transferFrom failed"
            );
        } else {
            token.burn(msg.sender, amount);
        }

        emit BridgeInitiated(msg.sender, recipient, amount, nonce);
    }
}
