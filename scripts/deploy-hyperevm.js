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

  console.log("Deploying to HyperEVM...");
  console.log("Deployer:", deployer.address);
  console.log("Relayer: ", relayerAddress);

  const SEPOLIA_CHAIN_ID = 11155111n;

  // Deploy BridgeToken (no faucet on HyperEVM — bridge controls mint)
  const BridgeToken = await ethers.getContractFactory("BridgeToken");
  const token = await BridgeToken.deploy("Wrapped Test Token", "wTTK", false);
  await token.waitForDeployment();
  console.log("BridgeToken deployed:", await token.getAddress());

  // Deploy Bridge in MINT mode
  const Bridge = await ethers.getContractFactory("Bridge");
  const bridge = await Bridge.deploy(
    await token.getAddress(),
    relayerAddress,
    SEPOLIA_CHAIN_ID,
    1 // Mode.MINT
  );
  await bridge.waitForDeployment();
  console.log("Bridge deployed:      ", await bridge.getAddress());

  // Authorize bridge to mint/burn wrapped tokens
  const tx = await token.setBridge(await bridge.getAddress());
  await tx.wait();
  console.log("Bridge authorized on BridgeToken");

  // Write deployments
  const deployment = {
    network: "hyperevm",
    chainId: 998,
    token: await token.getAddress(),
    bridge: await bridge.getAddress(),
    relayer: relayerAddress,
    mode: "MINT",
    deployedAt: new Date().toISOString(),
  };

  const outPath = path.join(__dirname, "../deployments/hyperevm.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(deployment, null, 2));
  console.log("Deployment saved to deployments/hyperevm.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
