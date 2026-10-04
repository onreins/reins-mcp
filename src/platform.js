/**
 * The Reins platform, for an AI: the same markets, theses, hot list, backtests
 * and agent plans a person gets on app.reins.one.
 *
 *   const p = new PlatformClient();
 *   await p.hotList();                         // this round's hot and cooling coins
 *   await p.thesis("ETH");                     // three reads on one coin, and limits
 *   await p.backtest("Buy ETH above its 200-day average, 10% stop");
 *   p.planAgent({ deposit: 500, lossPercent: 10, tradePercent: 20 });  // a create link
 *
 * Market data comes straight from the exchanges' public APIs (Hyperliquid,
 * Binance, Coinbase) and is read with the Charts page's own logic. Backtests
 * run on the Reins app. Nothing here holds a key or moves money: a plan comes
 * back as a link the owner opens and signs in their own wallet.
 */
import M from "./platform/markets.js";

const VENUES = {
  hyperliquid: (get) =>
    get("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    }).then(M.fromHyperliquid),
  binance: (get) =>
    get("https://api.binance.com/api/v3/ticker/24hr?type=MINI")
      .catch(() => get("https://api.binance.us/api/v3/ticker/24hr?type=MINI"))
      .then(M.fromBinance),
  coinbase: (get) => get("https://api.exchange.coinbase.com/products/stats").then(M.fromCoinbase),
};

const pct = (x, dp = 2) => (x == null ? null : Math.round(x * 100 * 10 ** dp) / 10 ** dp);
const round = (x, dp = 0) => (x == null ? null : Math.round(x * 10 ** dp) / 10 ** dp);

/** One market, in the words and units an agent reads best. */
function marketRow(r) {
  return {
    market: M.label(r),
    id: r.id,
    venue: r.venue,
    kind: r.kind,
    price: r.last,
    change24hPercent: pct(r.change),
    volume24hUsd: round(r.volUsd),
    ...(r.kind === "perp"
      ? { fundingAprPercent: r.funding == null ? null : pct(r.funding * 24 * 365, 1), openInterestUsd: round(r.oiUsd) }
      : {}),
  };
}

export class PlatformClient {
  /**
   * @param {object} [p]
   * @param {string} [p.appUrl]   the Reins app, for backtests and plan links
   * @param {typeof fetch} [p.fetch]
   * @param {number} [p.ttlMs]    how long one read of the exchanges is reused
   * @param {() => number} [p.now]
   */
  constructor({ appUrl = "https://app.reins.one", fetch = globalThis.fetch, ttlMs = 30_000, now = Date.now } = {}) {
    this.appUrl = appUrl.replace(/\/+$/, "");
    this._fetch = fetch;
    this.ttlMs = ttlMs;
    this.now = now;
    this._cache = null;
  }

  async _get(url, init) {
    const res = await this._fetch(url, { signal: AbortSignal.timeout(12_000), ...init });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res.json();
  }

  /** Every market on the three exchanges, read once per ttl. A venue that fails is left out and named. */
  async _rows() {
    if (this._cache && this.now() - this._cache.at < this.ttlMs) return this._cache;
    const get = (url, init) => this._get(url, init);
    const names = Object.keys(VENUES);
    const settled = await Promise.allSettled(names.map((n) => VENUES[n](get)));
    const venues = {};
    const rows = [];
    settled.forEach((s, i) => {
      venues[names[i]] = s.status === "fulfilled" ? "ok" : "unavailable";
      if (s.status === "fulfilled") rows.push(...s.value);
    });
    if (!rows.length) throw new Error("none of the exchanges answered; try again in a minute");
    this._cache = { at: this.now(), rows, venues };
    return this._cache;
  }

  /** Search the markets like the Charts page: by coin or pair, one venue or all, busiest first. */
  async markets({ query = "", venue = "all", limit = 20 } = {}) {
    const { rows, venues } = await this._rows();
    const list = M.view(rows, { query, venue, sort: "volUsd" });
    return { venues, total: list.length, markets: list.slice(0, limit).map(marketRow) };
  }

  /** The market a symbol means: an id (binance:BTCUSDT), a label (BTC-PERP, ETH/USDC), or a coin's busiest market. */
  async _find(symbol) {
    const { rows } = await this._rows();
    const s = String(symbol ?? "").trim();
    const up = s.toUpperCase();
    const hit =
      M.find(rows, s) ??
      rows.find((r) => M.label(r).toUpperCase() === up) ??
      M.view(rows, { sort: "volUsd" }).find((r) => r.base === up) ??
      rows.filter((r) => r.base === up).sort((a, b) => (b.volUsd ?? 0) - (a.volUsd ?? 0))[0];
    if (!hit) throw new Error(`no market for "${symbol}" on Hyperliquid, Binance or Coinbase`);
    return { rows, row: hit };
  }

  /** Three rule-based readers on one coin (trend, flow, risk), a verdict, and limits sized for its swings. */
  async thesis(symbol) {
    const { rows, row } = await this._find(symbol);
    const t = M.thesis(rows, row);
    return {
      ...marketRow(row),
      verdict: t.verdict,
      summary: t.summary,
      reads: t.reads.map((r) => ({ agent: r.agent, role: r.role, stance: r.stance, text: r.text })),
      suggestedLimits: t.rules,
      idea: M.idea(row, t),
      note: "A sample thesis from rule-based readers on the live 24-hour numbers, not advice.",
    };
  }

  /** This four-hour round's hottest and coolest coins, each with its thesis in a line. */
  async hotList({ limit = 8 } = {}) {
    const { rows, venues } = await this._rows();
    const { hot, cold } = M.hotList(rows, limit);
    const entry = (x) => ({
      ...marketRow(x.row),
      verdict: x.thesis.verdict,
      why: M.reason(x.thesis),
      summary: x.thesis.summary,
      suggestedLimits: x.thesis.rules,
      idea: M.idea(x.row, x.thesis),
    });
    const r = M.round(this.now());
    return {
      round: { startedAt: new Date(r.start).toISOString(), nextAt: new Date(r.next).toISOString() },
      venues,
      hot: hot.map(entry),
      cooling: cold.map(entry),
      note: "Coins need $5M of 24-hour volume to be listed. A sample read, not advice.",
    };
  }

  /** Describe a strategy in words; the Reins strategy chat turns it into rules and backtests it on real prices, after fees. */
  async backtest(strategy, { from } = {}) {
    const res = await this._fetch(`${this.appUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: String(strategy) }], ...(from ? { from } : {}) }),
      signal: AbortSignal.timeout(90_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `the strategy chat answered ${res.status}`);
    const b = body.backtest;
    if (!body.spec || !b) return { reply: body.reply, strategy: null, results: null, note: "No strategy was built from that. Answer the reply's question or describe it more concretely." };
    const s = b.strategy ?? {};
    return {
      reply: body.reply,
      strategy: body.spec,
      period: { asset: b.asset, timeframe: b.timeframe, from: b.from, to: b.to, days: b.days },
      results: {
        returnPercent: pct(s.return, 1),
        annualReturnPercent: pct(s.cagr, 1),
        worstDropPercent: pct(s.maxDrawdown, 1),
        trades: s.trades ?? null,
        winRatePercent: pct(s.winRate, 0),
        timeInMarketPercent: pct(s.exposure, 0),
        feesIncludedBps: b.feeBps ?? null,
      },
      buyAndHold: b.hold
        ? { returnPercent: pct(b.hold.return, 1), annualReturnPercent: pct(b.hold.cagr, 1), worstDropPercent: pct(b.hold.maxDrawdown, 1) }
        : null,
      note: "A backtest on past prices, not a promise.",
    };
  }

  /**
   * An agent's limits, checked and turned into a link to the create page with
   * them filled in. The owner opens it and signs in their own wallet; the
   * limits are then written into the agent's contract and can't be loosened.
   */
  planAgent({ deposit, lossPercent, tradePercent, bandPercent, market } = {}) {
    const plan = M.cleanPlan({ deposit, lossPercent, tradePercent, bandPercent });
    const lines = M.planLines(1, plan);
    return {
      plan,
      floorUsd: round(lines.floorUsd, 2),
      maxTradeUsd: round(lines.tradeUsd, 2),
      link: this.appUrl + M.createLink(plan) + (market ? "&from=" + encodeURIComponent(market) : ""),
      note: "Open the link to create the agent. Your wallet signs it; this server never can.",
    };
  }
}
