/* The Reins Charts page's market logic, copied from app.reins.one/markets.js so the
   MCP reads markets exactly the way the platform does: each exchange's 24-hour
   stats turned into one list, the three rule-based readers behind each coin's
   thesis, the hot list, and the create-page plan link. Keep it in step with
   the app's copy. */
const ReinsMarkets = (function () {
  "use strict";

  var HOUR = 3600 * 1000;
  var ROUND_MS = 4 * HOUR;
  var STABLE = { USDT: 1, USDC: 1, FDUSD: 1, USD: 1, TUSD: 1, BUSD: 1, DAI: 1, USDP: 1, USD1: 1, PYUSD: 1, USDS: 1 };
  // Binance tickers are glued together (BTCUSDT): split on the longest known quote.
  var BINANCE_QUOTES = ["FDUSD", "PYUSD", "USDT", "USDC", "TUSD", "BUSD", "USD1", "USDP", "AEUR", "EURI", "DAI", "BTC", "ETH", "BNB", "SOL", "XRP", "TRX", "DOGE",
    "EUR", "TRY", "BRL", "JPY", "ARS", "ZAR", "PLN", "RON", "UAH", "MXN", "COP", "CZK", "IDR"];
  var MIN_HOT_VOLUME = 5e6; // a coin needs $5M of 24h trading to make the hot list

  var num = function (x) { var n = Number(x); return x !== null && x !== "" && Number.isFinite(n) ? n : null; };
  var changeOf = function (last, open) { return last != null && open ? last / open - 1 : null; };

  /** USD value of one unit of each quote currency, from the venue's own USD(T) pairs. */
  function quotePrices(pairs) {
    var usd = Object.assign({}, STABLE);
    pairs.forEach(function (p) {
      if (STABLE[p.quote] && p.last && !usd[p.base]) usd[p.base] = p.last;
    });
    pairs.forEach(function (p) {
      if (STABLE[p.base] && p.last && !usd[p.quote]) usd[p.quote] = 1 / p.last; // USDTTRY: lira per tether
    });
    return usd;
  }
  function withVolume(pairs, volume) {
    var usd = quotePrices(pairs);
    return pairs.map(function (p) {
      var q = usd[p.quote];
      return Object.assign({}, p, { volUsd: q ? volume(p) * q : null });
    });
  }

  /** Binance spot, from /api/v3/ticker/24hr?type=MINI. Pairs with no trades (delisted) are left out. */
  function fromBinance(tickers) {
    var pairs = (tickers || []).map(function (t) {
      var quote = BINANCE_QUOTES.find(function (q) { return t.symbol.length > q.length && t.symbol.slice(-q.length) === q; });
      if (!quote || !num(t.count)) return null;
      var last = num(t.lastPrice), open = num(t.openPrice);
      return {
        id: "binance:" + t.symbol, venue: "binance", kind: "spot", base: t.symbol.slice(0, -quote.length), quote: quote,
        last: last, open: open, high: num(t.highPrice), low: num(t.lowPrice), change: changeOf(last, open), quoteVol: num(t.quoteVolume),
      };
    }).filter(Boolean);
    return withVolume(pairs, function (p) { return p.quoteVol || 0; });
  }

  /** Coinbase spot, from the Exchange API's /products/stats (keyed by BTC-USD). */
  function fromCoinbase(stats) {
    var pairs = Object.keys(stats || {}).map(function (id) {
      var s = stats[id] && stats[id].stats_24hour, parts = id.split("-");
      if (!s || parts.length !== 2 || !num(s.volume)) return null;
      var last = num(s.last), open = num(s.open);
      return {
        id: "coinbase:" + id, venue: "coinbase", kind: "spot", base: parts[0], quote: parts[1],
        last: last, open: open, high: num(s.high), low: num(s.low), change: changeOf(last, open), baseVol: num(s.volume),
      };
    }).filter(Boolean);
    return withVolume(pairs, function (p) { return (p.baseVol || 0) * (p.last || 0); });
  }

  /** Hyperliquid perpetuals, from the info API's metaAndAssetCtxs. Funding is per hour. */
  function fromHyperliquid(payload) {
    var meta = payload && payload[0], ctxs = (payload && payload[1]) || [];
    return ((meta && meta.universe) || []).map(function (u, i) {
      var c = ctxs[i];
      if (!c || u.isDelisted) return null;
      var last = num(c.markPx), open = num(c.prevDayPx), oi = num(c.openInterest);
      return {
        id: "hyperliquid:" + u.name, venue: "hyperliquid", kind: "perp", base: u.name, quote: "USD",
        last: last, open: open, high: null, low: null, change: changeOf(last, open), volUsd: num(c.dayNtlVlm),
        funding: num(c.funding), oiUsd: oi != null && last != null ? oi * last : null, maxLeverage: u.maxLeverage,
      };
    }).filter(function (r) { return r && r.volUsd; });
  }

  /** The list on screen: a venue (or favourites), a search, then a sort. */
  function view(rows, opts) {
    var o = opts || {}, q = String(o.query || "").trim().toUpperCase().replace(/[\s/-]+/g, "");
    var out = rows.filter(function (r) {
      if (o.venue === "fav") { if (!(o.favs || {})[r.id]) return false; }
      else if (o.venue && o.venue !== "all" && r.venue !== o.venue) return false;
      if (!q && STABLE[r.base] && STABLE[r.quote]) return false; // USDC/USDT clutters the top of the list
      return !q || r.base.indexOf(q) === 0 || (r.base + r.quote).indexOf(q) === 0 || (q.length > 2 && (r.base + r.quote).indexOf(q) >= 0);
    });
    var key = o.sort || "volUsd", dir = o.dir === "asc" ? 1 : -1;
    return out.slice().sort(function (a, b) {
      if (key === "name") return dir * (a.base + a.quote).localeCompare(b.base + b.quote);
      var x = a[key], y = b[key];
      if (x == null) return y == null ? 0 : 1;
      if (y == null) return -1;
      return dir * (x - y);
    });
  }

  function label(r) { return r.kind === "perp" ? r.base + "-PERP" : r.base + "/" + r.quote; }
  function find(rows, symbol) {
    var s = String(symbol || "").toLowerCase();
    return rows.find(function (r) { return r.id.toLowerCase() === s; }) || null;
  }

  // ------------------------------------------------------------ the thesis
  // Until hosted agents write them, three rule-based readers look at the same
  // live numbers an agent would: the trend, the money flowing in, and the risk.

  /** Where a market sits among its venue's: 0 (least traded) to 1 (most). */
  function volumeRank(rows, r) {
    var peers = rows.filter(function (x) { return x.venue === r.venue && x.volUsd != null; });
    if (!peers.length || r.volUsd == null) return null;
    var below = peers.filter(function (x) { return x.volUsd < r.volUsd; }).length;
    return below / Math.max(1, peers.length - 1);
  }
  function rangeOf(r) {
    if (r.high == null || r.low == null || !(r.high > r.low) || !r.last) return null;
    return { pos: (r.last - r.low) / (r.high - r.low), width: (r.high - r.low) / r.last };
  }
  var pctText = function (x, dp) { var v = (x * 100).toFixed(dp == null ? 1 : dp); return (x > 0 ? "+" : "") + v + "%"; };
  var absPct = function (x) { return Math.abs(x * 100).toFixed(1) + "%"; };

  function trendRead(r, range) {
    var ch = r.change || 0;
    if (ch >= 0.03 && (!range || range.pos >= 0.6)) {
      return { stance: "bull", score: ch >= 0.08 ? 2 : 1, short: range ? "At its highs" : "Trending up", text: "Up " + absPct(ch) + " in a day" + (range ? " and trading near the top of its range" : "") + ". Buyers are in control, so the trend agent would ride it with a loss limit underneath." };
    }
    if (ch <= -0.03 && (!range || range.pos <= 0.4)) {
      return { stance: "bear", score: ch <= -0.08 ? -2 : -1, short: range ? "Near its lows" : "Trending down", text: "Down " + absPct(ch) + " in a day" + (range ? " and pinned near its low" : "") + ". No reason to catch it yet. The trend agent waits for a higher low." };
    }
    if (ch >= 0.03) return { stance: "watch", score: 0, short: "Fading", text: "Up " + absPct(ch) + " but it has given back much of the day's high. The trend agent wants a clean push to new highs first." };
    if (ch <= -0.03) return { stance: "watch", score: 0, short: "Bouncing", text: "Down " + absPct(ch) + " but bouncing off its low. Too early to call a turn, so the trend agent watches it hold." };
    return { stance: "watch", score: 0, short: "Sideways", text: "Flat at " + pctText(ch) + " on the day. With no trend to follow, the trend agent stays out." };
  }

  function flowRead(r, rank) {
    var vol = r.volUsd != null ? money(r.volUsd) : "An unknown amount";
    var up = (r.change || 0) >= 0;
    if (r.kind === "perp" && r.funding != null) {
      var apr = r.funding * 24 * 365;
      if (apr >= 0.3) return { stance: "caution", score: -1, short: "Crowded longs", text: "Longs are paying " + absPct(apr) + " a year in funding to stay in. That's a crowded trade, and crowded trades unwind fast." };
      if (apr <= -0.1) return { stance: "bull", score: 1, short: "Shorts paying", text: "Shorts are paying " + absPct(apr) + " a year to hold their bets. If price rises they'll be forced to buy, which sets up a squeeze." };
    }
    if (rank != null && rank >= 0.9) return { stance: up ? "bull" : "bear", score: up ? 1 : -1, short: "Heavy volume", text: vol + " traded in 24 hours, in the busiest tenth of its exchange. Real money is behind this " + (up ? "rise" : "drop") + "." };
    if (rank != null && rank <= 0.3) return { stance: "caution", score: -1, short: "Thin market", text: "Only " + vol + " traded in 24 hours. Thin markets move on small orders, so prices here are easy to push around." };
    return { stance: "watch", score: 0, short: "Normal flow", text: vol + " traded in 24 hours, ordinary for its exchange. Nothing unusual in the flow." };
  }

  /** A loss limit that leaves room for twice a normal day's swing, in 5% steps from 5% to 30%. */
  function lossLimitFor(width) {
    var w = width == null ? 0.1 : width;
    return Math.max(5, Math.min(30, Math.ceil(Math.round(w * 2 * 1000) / 50) * 5));
  }
  function riskRead(r, range) {
    var width = range ? range.width : r.change != null ? Math.abs(r.change) * 1.5 : null;
    var loss = lossLimitFor(width);
    var trade = width != null && width > 0.15 ? 10 : width != null && width > 0.06 ? 20 : 25;
    var rules = { lossPercent: loss, tradePercent: trade };
    if (width == null) return { stance: "watch", score: 0, rules: rules, text: "Not enough data to size this. Start small, with a " + loss + "% loss limit." };
    if (width > 0.15) return { stance: "caution", score: -1, rules: rules, text: "Swung " + absPct(width) + " in one day. Keep trades to " + trade + "% of the deposit with a " + loss + "% loss limit, or sit it out." };
    if (width < 0.03) return { stance: "watch", score: 0, rules: rules, text: "Quiet, with a " + absPct(width) + " range today. Calm enough for trades of " + trade + "% at a time, with a " + loss + "% loss limit." };
    return { stance: "watch", score: 0, rules: rules, text: "A normal " + absPct(width) + " daily range. Trades of " + trade + "% with a " + loss + "% loss limit give it room to breathe." };
  }

  /** The sample thesis for one market: three reads, a combined score, and a verdict of hot, watch or cold. */
  function thesis(rows, r) {
    var range = rangeOf(r), rank = volumeRank(rows, r);
    var reads = [
      Object.assign({ agent: "Trend", role: "reads momentum" }, trendRead(r, range)),
      Object.assign({ agent: "Flow", role: "reads volume and funding" }, flowRead(r, rank)),
      Object.assign({ agent: "Risk", role: "sizes the trade" }, riskRead(r, range)),
    ];
    var score = reads.reduce(function (s, x) { return s + x.score; }, 0);
    var verdict = score >= 2 ? "hot" : score <= -2 ? "cold" : "watch";
    var name = label(r);
    var summary = verdict === "hot" ? name + " has momentum and money behind it. The agents lean in, sized for its swings."
      : verdict === "cold" ? name + " is under pressure. The agents stay out until it steadies."
      : name + " is mixed, with no clear edge this round. The agents watch and wait.";
    return { verdict: verdict, score: score, summary: summary, reads: reads, rules: reads[2].rules, volumeRank: rank, range: range };
  }

  /** The verdict in a few words: what the trend and the flow agents each saw. */
  function reason(t) {
    return t.reads[0].short + " · " + t.reads[1].short.toLowerCase();
  }

  /** The thesis as a plain-words strategy, ready for the strategy chat to backtest. */
  function idea(r, t) {
    var coin = r.base, rules = t.rules;
    var exit = "sell if it falls " + rules.lossPercent + "% from where I bought";
    var size = "trading " + rules.tradePercent + "% of the deposit at a time";
    if (t.verdict === "cold") return "Buy " + coin + " only once it closes back above its 20-day average after this drop, " + exit + ", " + size + ".";
    if (t.verdict === "hot") return "Buy " + coin + " when it's above its 20-day average and the 4-hour trend is up, " + exit + ", " + size + ".";
    return "Buy " + coin + " when it breaks above its 20-day high, " + exit + ", " + size + ".";
  }

  /**
   * The hot list: each coin once (its busiest market stands for it), with at
   * least $5M traded, ranked by thesis score and then by the day's move. Only
   * coins the agents lean towards are hot, and only ones they lean against are
   * cooling; a mixed coin is in neither.
   */
  function hotList(rows, n) {
    var size = n || 8, main = {};
    view(rows, { sort: "volUsd" }).forEach(function (r) { if (!main[r.base]) main[r.base] = r.id; });
    var ranked = rows
      .filter(function (r) { return main[r.base] === r.id && r.volUsd != null && r.volUsd >= MIN_HOT_VOLUME && r.change != null; })
      .map(function (r) { var t = thesis(rows, r); return { row: r, thesis: t, rank: t.score + r.change * 10 }; })
      .sort(function (a, b) { return b.rank - a.rank; });
    return {
      hot: ranked.filter(function (x) { return x.thesis.score > 0; }).slice(0, size),
      cold: ranked.filter(function (x) { return x.thesis.score < 0; }).reverse().slice(0, 5),
    };
  }

  // ------------------------------------------------------------- the plan
  // A person sets an agent's limits against a chart: where it starts, the
  // price that would freeze it, and its price band. The same ranges as the
  // create page's sliders, so a plan opens there as it is.
  var PLAN = { loss: [1, 60], trade: [5, 100], band: [0.1, 5], deposit: [5, 1e6] };
  var clamp = function (x, r) { return Math.min(r[1], Math.max(r[0], x)); };

  /** A plan with every number inside its range; anything missing or broken takes the default. */
  function cleanPlan(p) {
    var n = function (x, d) { var v = Number(x); return x !== null && x !== "" && Number.isFinite(v) ? v : d; };
    var o = p || {};
    return {
      deposit: Math.round(clamp(n(o.deposit, 1000), PLAN.deposit)),
      lossPercent: Math.round(clamp(n(o.lossPercent, 10), PLAN.loss)),
      tradePercent: Math.round(clamp(n(o.tradePercent, 25), PLAN.trade) / 5) * 5,
      bandPercent: Math.round(clamp(n(o.bandPercent, 1), PLAN.band) * 10) / 10,
    };
  }

  /** Where the plan's lines sit for a starting price, and what they mean in dollars. */
  function planLines(start, plan) {
    var p = cleanPlan(plan);
    return {
      start: start,
      floor: start * (1 - p.lossPercent / 100),
      bandHi: start * (1 + p.bandPercent / 100),
      bandLo: start * (1 - p.bandPercent / 100),
      floorUsd: p.deposit * (1 - p.lossPercent / 100),
      tradeUsd: Math.max(0.01, p.deposit * p.tradePercent / 100), // the create page's smallest trade
    };
  }

  /** A loss limit read back from where someone dragged the freeze line. */
  function lossFromFloor(start, floor) {
    if (!(start > 0) || !Number.isFinite(floor)) return null;
    return Math.round(clamp((1 - floor / start) * 100, PLAN.loss));
  }
  /** A price band read back from where someone dragged a band line. */
  function bandFromLine(start, price) {
    if (!(start > 0) || !Number.isFinite(price)) return null;
    return Math.round(clamp(Math.abs(price / start - 1) * 100, PLAN.band) * 10) / 10;
  }

  /** The create page, opened with this plan's limits (and the market it was planned on). */
  function createLink(plan, market) {
    var p = cleanPlan(plan);
    return "/create.html?loss=" + p.lossPercent + "&trade=" + p.tradePercent + "&band=" + p.bandPercent +
      "&deposit=" + p.deposit + (market ? "&from=" + encodeURIComponent(label(market)) : "");
  }

  /** The four-hour agent round a moment falls in, and when the next one starts. */
  function round(now) {
    var start = Math.floor(now / ROUND_MS) * ROUND_MS;
    return { start: start, next: start + ROUND_MS, left: start + ROUND_MS - now };
  }

  // ---------------------------------------------------------- formatting
  function price(p) {
    if (p == null) return "–";
    // Fixed places for each size, so a price doesn't change width between refreshes.
    if (p >= 100) return p.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
    if (p >= 1) return p.toLocaleString("en-US", { maximumFractionDigits: 4, minimumFractionDigits: 4 });
    return p.toLocaleString("en-US", { maximumSignificantDigits: 4, minimumSignificantDigits: 4 });
  }
  function money(v) {
    if (v == null) return "–";
    var a = Math.abs(v);
    return "$" + (a >= 1e9 ? (v / 1e9).toFixed(2) + "B" : a >= 1e6 ? (v / 1e6).toFixed(1) + "M" : a >= 1e3 ? (v / 1e3).toFixed(1) + "K" : v.toFixed(0));
  }
  function left(ms) {
    var m = Math.max(0, Math.round(ms / 60000));
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }

  return {
    ROUND_MS: ROUND_MS, MIN_HOT_VOLUME: MIN_HOT_VOLUME, PLAN: PLAN,
    cleanPlan: cleanPlan, planLines: planLines, lossFromFloor: lossFromFloor, bandFromLine: bandFromLine, createLink: createLink,
    fromBinance: fromBinance, fromCoinbase: fromCoinbase, fromHyperliquid: fromHyperliquid,
    view: view, label: label, find: find, thesis: thesis, reason: reason, idea: idea, hotList: hotList, round: round, lossLimitFor: lossLimitFor, volumeRank: volumeRank,
    price: price, money: money, left: left, pctText: pctText,
  };
})();

export default ReinsMarkets;
