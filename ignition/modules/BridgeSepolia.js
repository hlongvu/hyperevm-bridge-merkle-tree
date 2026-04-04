import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Sepolia deployment — LOCK mode
 *
 * Parameters (pass via --parameters or ignition.deploy options):
 *   relayer    (string)  — address of the trusted relayer wallet
 *
 * Deploys:
 *   1. BridgeToken  (name="Test Token", symbol="TTK", faucetEnabled=true)
 *   2. Bridge       (mode=LOCK, destChainId=998)
 *   3. Calls setBridge on the token to authorize the bridge
 */
export default buildModule("BridgeSepolia", (m) => {
  const relayer = m.getParameter("relayer");

  const HYPEREVM_CHAIN_ID = 998n;
  const LOCK = 0n;

  const token = m.contract("BridgeToken", ["Test Token", "TTK", true]);

  const bridge = m.contract("Bridge", [
    token,           // token address (Ignition resolves Future → address)
    relayer,
    HYPEREVM_CHAIN_ID,
    LOCK,
  ]);

  // Authorize the bridge to transfer tokens out of escrow
  m.call(token, "setBridge", [bridge]);

  return { token, bridge };
});
