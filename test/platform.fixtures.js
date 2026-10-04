/**
 * Canned exchange and app answers, so the platform tools can be tested
 * without the network. The numbers are shaped like the real APIs' replies.
 */
import { PlatformClient } from "../src/platform.js";

export const APP = "https://app.example";

export const hyperliquid = [
  {
    universe: [
      { name: "BTC", maxLeverage: 40 },
      { name: "PUMP", maxLeverage: 5 },
      { name: "WLD", maxLeverage: 10 },
      { name: "OLD", maxLeverage: 3, isDelisted: true },
    ],
  },
  [
    { markPx: "85262.0", prevDayPx: "84838.0", dayNtlVlm: "2000000000", funding: "0.0000125", openInterest: "30000" },
    { markPx: "0.006281", prevDayPx: "0.005749", dayNtlVlm: "154000000", funding: "0.00001", openInterest: "9000000000" },
    { markPx: "0.582", prevDayPx: "0.6096", dayNtlVlm: "60000000", funding: "0.00001", openInterest: "20000000" },
    { markPx: "1", prevDayPx: "1", dayNtlVlm: "1", funding: "0", openInterest: "0" },
  ],
];

export const binance = [
  { symbol: "BTCUSDT", lastPrice: "85250.00", openPrice: "84850.00", highPrice: "85900.00", lowPrice: "84100.00", quoteVolume: "1500000000", count: 900000 },
  { symbol: "ETHBTC", lastPrice: "0.03165", openPrice: "0.03150", highPrice: "0.03180", lowPrice: "0.03120", quoteVolume: "900", count: 40000 },
  { symbol: "USDCUSDT", lastPrice: "1.0001", openPrice: "1.0000", highPrice: "1.0002", lowPrice: "0.9998", quoteVolume: "800000000", count: 50000 },
];

export const coinbase = {
  "BTC-USD": { stats_24hour: { open: "84840", high: "85880", low: "84120", last: "85255", volume: "9000" } },
  "EURC-USDC": { stats_24hour: { open: "1.137", high: "1.140", low: "1.135", last: "1.138", volume: "2000000" } },
};

export const chat = {
  reply: "Here's an ETH trend filter with a 10% stop-loss.",
  spec: { type: "rules", name: "ETH 200-day trend", asset: "ETH", stop_loss_pct: 10, position_pct: 100 },
  source: "model",
  backtest: {
    asset: "ETH",
    timeframe: "1d",
    from: "2021-01-01",
    to: "2026-09-25",
    days: 2094,
    feeBps: 10,
    strategy: { return: 1.234, cagr: 0.1512, maxDrawdown: -0.381, trades: 27, winRate: 0.41, exposure: 0.55, feesPaid: 31.2 },
    hold: { return: 2.5, cagr: 0.25, maxDrawdown: -0.79 },
    curve: new Array(300).fill(1),
  },
};

const reply = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });

/**
 * A fetch that answers like the three exchanges and the app. `down` names
 * venues that should fail; every call is recorded in `calls`.
 */
export function stubFetch({ down = [], calls = [] } = {}) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (u.includes("hyperliquid")) return down.includes("hyperliquid") ? reply({}, false) : reply(hyperliquid);
    if (u.includes("binance")) return down.includes("binance") ? reply({}, false) : reply(binance);
    if (u.includes("coinbase")) return down.includes("coinbase") ? reply({}, false) : reply(coinbase);
    if (u === `${APP}/api/chat`) return reply(chat);
    throw new Error(`unexpected fetch ${u}`);
  };
}

export const stubPlatform = (opts) => new PlatformClient({ appUrl: APP, fetch: stubFetch(opts) });
