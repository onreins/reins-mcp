/**
 * Hardhat is used for exactly one thing here: a local JSON-RPC node to test
 * against. Compilation is done by scripts/compile.js and everything else is
 * plain viem, so the project is not tied to a framework.
 *
 * Note: a local node cannot reproduce Arc's specific behaviour (USDC-as-gas
 * accounting, EIP-7708 transfer logs, the 20 gwei base-fee floor). It proves
 * the contract logic; testnet proves the integration.
 */
module.exports = {
  solidity: "0.8.28",
  networks: {
    hardhat: {
      chainId: 31337,
      mining: { auto: true },
      // Mirror Arc's fee floor so gas arithmetic in tests is representative.
      initialBaseFeePerGas: 20_000_000_000,
      accounts: { accountsBalance: "10000000000000000000000" }, // 10,000 USDC (18dp)
    },
  },
};
