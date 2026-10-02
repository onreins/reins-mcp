/**
 * Reference agent: EUR/USD reversion, trading through a Mandate.
 *
 *   node --env-file=.env examples/fx-reversion.js --once      # one decision
 *   node --env-file=.env examples/fx-reversion.js             # loop
 *
 * !! This strategy does not work on Arc, and we measured it rather than
 * !! guessed. Over 23.8 hours of live mainnet data the pool moved 33.7bp in
 * !! total and 0.48bp per minute, against a 10bp round-trip cost, so every
 * !! threshold at or above cost fired zero trades. The Chainlink feed it
 * !! reads updates on a 0.5% deviation, making it accurate to about +/-50bp:
 * !! precise enough to refuse a bad fill, nowhere near precise enough to be a
 * !! signal. Measure before building on this.
 * !!
 * !! It stays in the repo as a worked example of driving a Mandate from the
 * !! SDK, and because its refusals are what the testnet run exercises.
 *
 * The idea is deliberately simple and explainable. Chainlink's EUR/USD stands
 * in for fair value; the Uniswap USDC/EURC pool drifts around it as people
 * trade. When EURC is cheap in the pool (below the oracle by more than the
 * pool fee plus a margin), buy it; when it's rich, sell it back. Every
 * decision is logged with its reason, so anyone watching can see why.
 *
 * The agent is not trusted with anything. It holds only its own key; the
 * Mandate decides what that key may do.
 *
 * Environment: MANDATE_ADDRESS, MANDATE_AGENT_KEY, MANDATE_RPC (optional),
 * AGENT_EDGE_BPS (default 15), AGENT_TRADE_USD (default: the mandate's limit),
 * AGENT_INTERVAL_SEC (default 60).
 */
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseAbi, keccak256, encodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc } from "viem/chains";

import { MandateClient } from "../src/sdk.js";

const STATE_VIEW = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b";
const POOL = {
  currency0: "0x3600000000000000000000000000000000000000", // USDC
  currency1: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1", // EURC
  fee: 500,
  tickSpacing: 10,
  hooks: "0x0000000000000000000000000000000000000000",
};
const POOL_FEE_BPS = 5;

/**
 * The pure decision. No network, no keys: given prices and holdings, say what
 * to do and why. Kept separate so it can be tested and audited on its own.
 *
 * @param {object} s
 * @param {number} s.oracleUsd      Chainlink EURC/USD
 * @param {number} s.poolUsd        USD per EURC implied by the pool
 * @param {number} s.usdc           USDC held
 * @param {number} s.eurc           EURC held
 * @param {number} s.maxTradeUsd    the mandate's per-trade limit
 * @param {number} [s.edgeBps]      required mispricing beyond the pool fee
 * @param {number} [s.tradeUsd]     preferred trade size
 */
export function decide({ oracleUsd, poolUsd, usdc, eurc, maxTradeUsd, edgeBps = 15, tradeUsd }) {
  const gapBps = ((poolUsd - oracleUsd) / oracleUsd) * 10_000;
  const need = edgeBps + POOL_FEE_BPS;
  const size = Math.min(tradeUsd ?? maxTradeUsd, maxTradeUsd);
  const floor6 = (n) => Math.floor(n * 1e6) / 1e6;

  if (gapBps <= -need && usdc >= 0.01) {
    const spend = floor6(Math.min(size, usdc));
    return {
      action: "buy",
      from: "USDC",
      to: "EURC",
      amount: String(spend),
      reason: `EURC is ${(-gapBps).toFixed(1)} bps cheap in the pool vs Chainlink (needs ${need}); buying $${spend}`,
    };
  }
  if (gapBps >= need && eurc * poolUsd >= 0.01) {
    const sell = floor6(Math.min(size / poolUsd, eurc));
    return {
      action: "sell",
      from: "EURC",
      to: "USDC",
      amount: String(sell),
      reason: `EURC is ${gapBps.toFixed(1)} bps rich in the pool vs Chainlink (needs ${need}); selling ${sell} EURC`,
    };
  }
  return {
    action: "hold",
    reason: `pool is ${gapBps >= 0 ? "+" : ""}${gapBps.toFixed(1)} bps from Chainlink; need ±${need} to act`,
  };
}

/** USD per EURC implied by the pool's current price. */
export async function poolUsdPerEurc(publicClient) {
  const id = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [POOL.currency0, POOL.currency1, POOL.fee, POOL.tickSpacing, POOL.hooks],
    ),
  );
  const [sqrtPriceX96] = await publicClient.readContract({
    address: STATE_VIEW,
    abi: parseAbi(["function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)"]),
    functionName: "getSlot0",
    args: [id],
  });
  // price = currency1 per currency0 = EURC per USDC (both 6 decimals).
  const eurcPerUsdc = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  return 1 / eurcPerUsdc;
}

async function step(mandate, publicClient, opts) {
  const [status, oracle, poolUsd] = await Promise.all([
    mandate.status(),
    mandate.price("EURC"),
    poolUsdPerEurc(publicClient),
  ]);
  const held = Object.fromEntries(status.holdings.map((h) => [h.symbol, h.amount]));
  const d = decide({
    oracleUsd: oracle.usd,
    poolUsd,
    usdc: held.USDC ?? 0,
    eurc: held.EURC ?? 0,
    maxTradeUsd: status.rules.maxTradeUsd,
    ...opts,
  });
  const at = new Date().toISOString();
  if (!status.canTrade) {
    console.log(JSON.stringify({ at, action: "wait", reason: "the mandate can't trade right now (frozen, expired or stale price)" }));
    return;
  }
  if (d.action === "hold") {
    console.log(JSON.stringify({ at, ...d, equityUsd: status.equityUsd }));
    return;
  }
  try {
    const r = await mandate.trade({ from: d.from, to: d.to, amount: d.amount });
    console.log(JSON.stringify({ at, ...d, tx: r.hash, received: r.bought, equityUsd: r.equityUsd }));
  } catch (err) {
    console.log(JSON.stringify({ at, ...d, refused: err.mandate ?? { reason: err.message } }));
  }
}

async function main() {
  const address = process.env.MANDATE_ADDRESS;
  const key = process.env.MANDATE_AGENT_KEY;
  if (!address || !key) {
    console.error("set MANDATE_ADDRESS and MANDATE_AGENT_KEY");
    process.exit(1);
  }
  const transport = http(process.env.MANDATE_RPC);
  const publicClient = createPublicClient({ chain: arc, transport });
  const wallet = createWalletClient({ account: privateKeyToAccount(key), chain: arc, transport });
  const mandate = new MandateClient({ publicClient, wallet, address });
  const opts = {
    edgeBps: Number(process.env.AGENT_EDGE_BPS ?? 15),
    tradeUsd: process.env.AGENT_TRADE_USD ? Number(process.env.AGENT_TRADE_USD) : undefined,
  };

  if (process.argv.includes("--once")) return step(mandate, publicClient, opts);
  const everyMs = Number(process.env.AGENT_INTERVAL_SEC ?? 60) * 1000;
  for (;;) {
    await step(mandate, publicClient, opts).catch((err) => console.error(`step failed: ${err.message}`));
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

const invokedDirectly =
  process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
