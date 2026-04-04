import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { config as dotenvConfig } from "dotenv";

dotenvConfig();

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "0x" + "0".repeat(64);
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL;
const HYPEREVM_RPC_URL = process.env.HYPEREVM_RPC_URL || "https://rpc.hyperliquid-testnet.xyz/evm";

const networks = {
  hyperevm: {
    type: "http",
    url: HYPEREVM_RPC_URL,
    accounts: [DEPLOYER_PRIVATE_KEY],
    chainId: 998,
  },
};

if (SEPOLIA_RPC_URL) {
  networks.sepolia = {
    type: "http",
    url: SEPOLIA_RPC_URL,
    accounts: [DEPLOYER_PRIVATE_KEY],
    chainId: 11155111,
  };
}

/** @type import('hardhat/config').HardhatUserConfig */
export default {
  plugins: [hardhatToolboxMochaEthers],
  solidity: "0.8.28",
  networks,
};
