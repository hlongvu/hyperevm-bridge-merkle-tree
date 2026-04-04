import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * HyperEVM deployment — MINT mode
 *
 * Parameters (pass via --parameters or ignition.deploy options):
 *   relayer    (string)  — address of the trusted relayer wallet
 *
 * Deploys:
 *   1. BridgeToken  (name="Wrapped Test Token", symbol="wTTK", faucetEnabled=false)
 *   2. Bridge       (mode=MINT, destChainId=11155111)
 *   3. Calls setBridge on the token to authorize the bridge
 */
export default buildModule("BridgeHyperEVM", (m) => {
  const relayer = m.getParameter("relayer");

  const SEPOLIA_CHAIN_ID = 11155111n;
  const MINT = 1n;

  const token = m.contract("BridgeToken", ["Wrapped Test Token", "wTTK", false]);

  const bridge = m.contract("Bridge", [
    token,
    relayer,
    SEPOLIA_CHAIN_ID,
    MINT,
  ]);

  // Authorize the bridge to mint/burn wrapped tokens
  m.call(token, "setBridge", [bridge]);

  return { token, bridge };
});
