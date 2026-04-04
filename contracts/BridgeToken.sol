// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title BridgeToken
 * @notice ERC20 token with bridge-controlled mint/burn.
 *         On Sepolia: real asset, has faucet.
 *         On HyperEVM: wrapped representation, no faucet.
 */
contract BridgeToken is ERC20, Ownable {
    address public bridge;
    bool public faucetEnabled;

    uint256 public constant FAUCET_AMOUNT = 200 * 1e18;

    event BridgeSet(address indexed bridge);

    constructor(
        string memory name,
        string memory symbol,
        bool _faucetEnabled
    ) ERC20(name, symbol) Ownable(msg.sender) {
        faucetEnabled = _faucetEnabled;
    }

    modifier onlyBridge() {
        require(msg.sender == bridge, "BridgeToken: caller is not the bridge");
        _;
    }

    /**
     * @notice Set the authorized bridge contract. Only callable by owner.
     */
    function setBridge(address _bridge) external onlyOwner {
        bridge = _bridge;
        emit BridgeSet(_bridge);
    }

    /**
     * @notice Mint tokens to an address. Only callable by the bridge.
     */
    function mint(address to, uint256 amount) external onlyBridge {
        _mint(to, amount);
    }

    /**
     * @notice Burn tokens from an address. Only callable by the bridge.
     */
    function burn(address from, uint256 amount) external onlyBridge {
        _burn(from, amount);
    }

    /**
     * @notice Faucet — mint 200 test tokens to caller. Only enabled on Sepolia.
     */
    function faucet() external {
        require(faucetEnabled, "BridgeToken: faucet not enabled");
        _mint(msg.sender, FAUCET_AMOUNT);
    }
}
