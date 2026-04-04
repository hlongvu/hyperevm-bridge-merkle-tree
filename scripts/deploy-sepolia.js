import hre from "hardhat";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const { ethers } = hre;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const [deployer] = await ethers.getSigners();
  const relayerAddress = process.env.RELAYER_ADDRESS;

  if (!relayerAddress) {
    throw new Error("RELAYER_ADDRESS env var not set");
  }

  console.log("Deploying to Sepolia...");
  console.log("Deployer:", deployer.address);
  console.log("Relayer: ", relayerAddress);

  const HYPEREVM_CHAIN_ID = 998n;

  // Deploy BridgeToken (faucet enabled on Sepolia)
  const BridgeToken = await ethers.getContractFactory("BridgeToken");
  const token = await BridgeToken.deploy("Test Token", "TTK", true);
  await token.waitForDeployment();
  console.log("BridgeToken deployed:", await token.getAddress());

  // Deploy Bridge in LOCK mode
  const Bridge = await ethers.getContractFactory("Bridge");
  const bridge = await Bridge.deploy(
    await token.getAddress(),
    relayerAddress,
    HYPEREVM_CHAIN_ID,
    0 // Mode.LOCK
  );
  await bridge.waitForDeployment();
  console.log("Bridge deployed:      ", await bridge.getAddress());

  // Authorize bridge to transfer from escrow
  const tx = await token.setBridge(await bridge.getAddress());
  await tx.wait();
  console.log("Bridge authorized on BridgeToken");

  // Write deployments
  const deployment = {
    network: "sepolia",
    chainId: 11155111,
    token: await token.getAddress(),
    bridge: await bridge.getAddress(),
    relayer: relayerAddress,
    mode: "LOCK",
    deployedAt: new Date().toISOString(),
  };

  const outPath = path.join(__dirname, "../deployments/sepolia.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(deployment, null, 2));
  console.log("Deployment saved to deployments/sepolia.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
