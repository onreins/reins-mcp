/**
 * Test rig: a local node and funded actors.
 */
import { createPublicClient, createWalletClient, http, defineChain } from "viem";
import { mnemonicToAccount } from "viem/accounts";

export const RPC_URL = process.env.LOCAL_RPC ?? "http://127.0.0.1:8545";

/** Hardhat's local node, configured to mirror Arc's USDC-as-native-gas shape. */
export const localChain = defineChain({
  id: 31337,
  name: "Local",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const MNEMONIC = "test test test test test test test test test test test junk";

export const account = (index) => mnemonicToAccount(MNEMONIC, { addressIndex: index });

export const publicClient = createPublicClient({ chain: localChain, transport: http(RPC_URL) });

export const walletFor = (index) =>
  createWalletClient({ account: account(index), chain: localChain, transport: http(RPC_URL) });

/** Mine `n` blocks instantly — used to fast-forward challenge windows. */
export async function mine(n) {
  await publicClient.request({
    method: "hardhat_mine",
    params: [`0x${BigInt(n).toString(16)}`],
  });
}

export const balanceOf = (address) => publicClient.getBalance({ address });

/** Assert a contract call reverts with a specific custom error name. */
export async function expectRevert(promise, errorName) {
  try {
    await promise;
  } catch (err) {
    const text = `${err.shortMessage ?? ""} ${err.message ?? ""} ${err.metaMessages?.join(" ") ?? ""}`;
    if (!text.includes(errorName)) {
      throw new Error(`expected revert "${errorName}" but got: ${text.slice(0, 400)}`);
    }
    return err;
  }
  throw new Error(`expected revert "${errorName}" but the call succeeded`);
}

/** Wait for the local node to accept connections. */
export async function waitForNode(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await publicClient.getBlockNumber();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw new Error(`local node at ${RPC_URL} never became ready: ${lastError?.message}`);
}
