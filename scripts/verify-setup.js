import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BRIDGE_ABI = [
  "function token() view returns (address)",
  "function relayer() view returns (address)",
  "function destChainId() view returns (uint256)",
  "function mode() view returns (uint8)",
  "function outboundNonce() view returns (uint256)",
];

const TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function bridge() view returns (address)",
  "function faucetEnabled() view returns (bool)",
  "function totalSupply() view returns (uint256)",
];

const MODE = ["LOCK", "MINT"];

async function verifyChain(chainName, rpcUrl, deploymentPath) {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Chain: ${chainName.toUpperCase()}`);
  console.log(`RPC:   ${rpcUrl}`);
  console.log("=".repeat(50));

  if (!fs.existsSync(deploymentPath)) {
    console.log(`  [SKIP] No deployment file found at ${deploymentPath}`);
    return;
  }

  const dep = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
  console.log(`  Deployed at: ${dep.deployedAt}`);
  console.log(`  Token:  ${dep.token}`);
  console.log(`  Bridge: ${dep.bridge}`);
  console.log(`  Relayer: ${dep.relayer}`);

  const provider = new ethers.JsonRpcProvider(rpcUrl);

  try {
    const network = await provider.getNetwork();
    console.log(`  Network chain ID: ${network.chainId}`);
    if (network.chainId !== BigInt(dep.chainId)) {
      console.log(`  [WARN] Chain ID mismatch! Expected ${dep.chainId}, got ${network.chainId}`);
    }

    const token = new ethers.Contract(dep.token, TOKEN_ABI, provider);
    const bridge = new ethers.Contract(dep.bridge, BRIDGE_ABI, provider);

    const [
      tokenName,
      tokenSymbol,
      tokenBridge,
      faucetEnabled,
      totalSupply,
      bridgeToken,
      bridgeRelayer,
      destChainId,
      mode,
      outboundNonce,
    ] = await Promise.all([
      token.name(),
      token.symbol(),
      token.bridge(),
      token.faucetEnabled(),
      token.totalSupply(),
      bridge.token(),
      bridge.relayer(),
      bridge.destChainId(),
      bridge.mode(),
      bridge.outboundNonce(),
    ]);

    console.log("\n  Token:");
    console.log(`    name:          ${tokenName}`);
    console.log(`    symbol:        ${tokenSymbol}`);
    console.log(`    totalSupply:   ${ethers.formatEther(totalSupply)}`);
    console.log(`    faucetEnabled: ${faucetEnabled}`);
    console.log(`    bridge:        ${tokenBridge}`);
    console.log(`    bridge match:  ${tokenBridge.toLowerCase() === dep.bridge.toLowerCase() ? "OK" : "MISMATCH"}`);

    console.log("\n  Bridge:");
    console.log(`    mode:          ${MODE[mode]}`);
    console.log(`    token:         ${bridgeToken}`);
    console.log(`    relayer:       ${bridgeRelayer}`);
    console.log(`    destChainId:   ${destChainId}`);
    console.log(`    outboundNonce: ${outboundNonce}`);
    console.log(`    token match:   ${bridgeToken.toLowerCase() === dep.token.toLowerCase() ? "OK" : "MISMATCH"}`);
    console.log(`    relayer match: ${bridgeRelayer.toLowerCase() === dep.relayer.toLowerCase() ? "OK" : "MISMATCH"}`);

    console.log("\n  [PASS] Setup looks correct");
  } catch (err) {
    console.log(`  [ERROR] ${err.message}`);
  }
}

async function main() {
  const sepoliaRpc = process.env.SEPOLIA_RPC_URL;
  const hyperevmRpc = process.env.HYPEREVM_RPC_URL || "https://rpc.hyperliquid-testnet.xyz/evm";

  if (!sepoliaRpc) {
    console.log("[WARN] SEPOLIA_RPC_URL not set, skipping Sepolia check");
  } else {
    await verifyChain(
      "sepolia",
      sepoliaRpc,
      path.join(__dirname, "../deployments/sepolia.json")
    );
  }

  await verifyChain(
    "hyperevm",
    hyperevmRpc,
    path.join(__dirname, "../deployments/hyperevm.json")
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
