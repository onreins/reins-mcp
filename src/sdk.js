/**
 * Mandate SDK: create, fund, inspect and trade through a Mandate.
 *
 *   const m = new MandateClient({ publicClient, wallet, address });
 *   await m.status();                       // equity, holdings, rules, headroom
 *   await m.trade({ from: "USDC", to: "EURC", amount: "5" });
 *
 * Amounts are human-readable strings ("5" = five dollars / five EURC).
 * The contract enforces every rule, so the SDK never needs to be trusted: a
 * trade that breaks a rule simply reverts, and `explain()` turns the revert
 * into a sentence an AI agent can act on.
 */
import { parseAbi, parseUnits, formatUnits, decodeEventLog, BaseError, ContractFunctionRevertedError } from "viem";

import { artifact } from "./artifacts.js";
import { pushPrice } from "./redstone.js";

/** Tries at pushing a fresh oracle price before a trade, when the RPC is busy. */
const PUSH_ATTEMPTS = 3;

const MANDATE = artifact("Mandate");
const FACTORY = artifact("MandateFactory");
const VENUE = artifact("UniswapV4Venue");
const ERC20 = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const FEED = parseAbi([
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
]);

/** Factory errors can come from inside the Mandate it deploys; decode both. */
const FACTORY_ABI = [...FACTORY.abi, ...MANDATE.abi.filter((x) => x.type === "error")];

/**
 * A trade can also be refused one level down, by the exchange. The mandate
 * hands the venue its oracle floor as the minimum, so a pool that cannot beat
 * that floor reverts first and the mandate's own PriceTooLow never runs.
 * Decoding the venue's errors too is what turns that into a sentence.
 */
const TRADE_ABI = [...MANDATE.abi, ...VENUE.abi.filter((x) => x.type === "error")];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Plain-language reasons for every rule a trade can hit. */
const REASONS = {
  NotAgent: "this key is not the mandate's agent (it may have been revoked)",
  IsFrozen: "the mandate is frozen after hitting its loss limit; only the owner can resume it",
  MandateExpired: "the mandate has expired",
  AssetNotAllowed: "that asset is not allowed by this mandate",
  SameAsset: "cannot trade an asset for itself",
  TradeTooLarge: "the trade is larger than the mandate's per-trade limit",
  PriceTooLow: "the exchange offered a worse price than the mandate allows",
  InsufficientOutput: "the exchange offered a worse price than the mandate allows; the pool is too thin for this size",
  DrawdownLimit: "the trade would take losses past the mandate's loss limit",
  StalePrice: "the oracle price is too old to trade on right now",
  BadPrice: "the oracle returned an invalid price",
  OverSpent: "the exchange tried to take more than the trade amount",
  Reentrancy: "a nested call was blocked",
  NotOwner: "only the mandate's owner can do that",
};

/** Turn a revert into { rule, reason } an agent (or a person) can act on. */
export function explain(err) {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    const name = revert?.data?.errorName;
    if (name) return { rule: name, reason: REASONS[name] ?? name };
    const text = `${err.shortMessage ?? ""} ${err.message ?? ""}`;
    if (/slippage/i.test(text)) return { rule: "PriceTooLow", reason: REASONS.PriceTooLow };
    return { rule: "Reverted", reason: err.shortMessage ?? err.message };
  }
  return { rule: "Error", reason: err?.message ?? String(err) };
}

export class MandateClient {
  /**
   * @param {object} p
   * @param {import("viem").PublicClient} p.publicClient
   * @param {import("viem").WalletClient} [p.wallet]  the agent's (or owner's) wallet
   * @param {`0x${string}`} p.address                 the mandate
   */
  constructor({ publicClient, wallet, address }) {
    this.publicClient = publicClient;
    this.wallet = wallet;
    this.address = address;
    this._tokens = null;
  }

  _read(functionName, args = []) {
    return this.publicClient.readContract({ address: this.address, abi: MANDATE.abi, functionName, args });
  }

  /** Every token the mandate can hold, keyed by symbol, base first. */
  async tokens() {
    if (this._tokens) return this._tokens;
    const base = await this._read("base");
    const list = [base, ...(await this._read("assetList"))];
    const entries = await Promise.all(
      list.map(async (address, i) => {
        const [symbol, decimals] = await Promise.all([
          this.publicClient.readContract({ address, abi: ERC20, functionName: "symbol" }),
          this.publicClient.readContract({ address, abi: ERC20, functionName: "decimals" }),
        ]);
        const feed = i === 0 ? null : (await this._read("assets", [address]))[0];
        return [symbol, { address, symbol, decimals, feed, isBase: i === 0 }];
      }),
    );
    this._tokens = Object.fromEntries(entries);
    return this._tokens;
  }

  async _base() {
    return Object.values(await this.tokens()).find((t) => t.isBase);
  }

  async _token(symbolOrAddress) {
    const tokens = await this.tokens();
    const key = String(symbolOrAddress);
    const hit =
      (Object.hasOwn(tokens, key) ? tokens[key] : undefined) ??
      Object.values(tokens).find((t) => t.address.toLowerCase() === key.toLowerCase());
    if (!hit) throw new Error(`"${key.slice(0, 40)}" is not in this mandate (have: ${Object.keys(tokens).join(", ")})`);
    return hit;
  }

  /** Oracle price in dollars and when it was last updated. */
  async price(symbol) {
    const t = await this._token(symbol);
    if (t.isBase) return { usd: 1, updatedAt: null };
    const [[, answer, , updatedAt], dec] = await Promise.all([
      this.publicClient.readContract({ address: t.feed, abi: FEED, functionName: "latestRoundData" }),
      this.publicClient.readContract({ address: t.feed, abi: FEED, functionName: "decimals" }),
    ]);
    return { usd: Number(answer) / 10 ** dec, updatedAt: new Date(Number(updatedAt) * 1000).toISOString() };
  }

  /** Everything an agent needs to decide: money, holdings, rules, and room left. */
  async status() {
    const tokens = await this.tokens();
    const base = await this._base();
    const fields = [
      "agent",
      "owner",
      "frozen",
      "expiresAt",
      "maxTradeValue",
      "maxDrawdownBps",
      "maxSlippageBps",
      "maxPriceAge",
      "baseline",
      "floor",
    ];
    const [agent, owner, frozen, expiresAt, maxTradeValue, maxDrawdownBps, maxSlippageBps, maxPriceAge, baseline, floor] =
      await Promise.all(fields.map((f) => this._read(f)));

    let equity = null;
    try {
      equity = await this._read("equity");
    } catch {
      // A stale feed: equity can't be trusted, and the contract blocks trading until it updates.
    }
    const holdings = await Promise.all(
      Object.values(tokens).map(async (t) => {
        const raw = await this.publicClient.readContract({
          address: t.address,
          abi: ERC20,
          functionName: "balanceOf",
          args: [this.address],
        });
        const usd = await this.price(t.symbol).then((p) => p.usd).catch(() => null);
        const amount = Number(formatUnits(raw, t.decimals));
        return { symbol: t.symbol, amount, valueUsd: usd === null ? null : amount * usd };
      }),
    );
    const dollars = (v) => Number(formatUnits(v, base.decimals));
    return {
      mandate: this.address,
      owner,
      agent,
      frozen,
      canTrade: !frozen && Date.now() / 1000 < Number(expiresAt) && equity !== null,
      expiresAt: new Date(Number(expiresAt) * 1000).toISOString(),
      equityUsd: equity === null ? null : dollars(equity),
      holdings,
      rules: {
        maxTradeUsd: dollars(maxTradeValue),
        maxLossPercent: Number(maxDrawdownBps) / 100,
        maxSlippagePercent: Number(maxSlippageBps) / 100,
        maxPriceAgeSeconds: Number(maxPriceAge),
        allowedAssets: Object.keys(tokens),
      },
      baselineUsd: dollars(baseline),
      floorUsd: dollars(floor),
      lossHeadroomUsd: equity === null ? null : Math.max(0, dollars(equity) - dollars(floor)),
    };
  }

  /**
   * Would this trade go through? Simulates it against the contract without
   * sending anything, so an agent can plan around a rule instead of hitting it.
   * Returns { allowed, wouldReceive } or { allowed: false, rule, reason }, with
   * the trade's size against the cap and, when it's too big, the most it could do.
   */
  async check({ from, to, amount }) {
    const [tIn, tOut, s] = await Promise.all([this._token(from), this._token(to), this.status()]);
    const usdIn = await this.price(tIn.symbol).then((p) => p.usd).catch(() => null);
    const sizes = {
      tradeUsd: usdIn === null ? null : Number(amount) * usdIn,
      maxTradeUsd: s.rules.maxTradeUsd,
      lossHeadroomUsd: s.lossHeadroomUsd,
    };
    try {
      const { result } = await this.publicClient.simulateContract({
        address: this.address,
        abi: TRADE_ABI,
        functionName: "trade",
        args: [tIn.address, tOut.address, parseUnits(String(amount), tIn.decimals), 0n],
        account: this.wallet?.account ?? s.agent,
      });
      return { allowed: true, wouldReceive: { symbol: tOut.symbol, amount: Number(formatUnits(result, tOut.decimals)) }, ...sizes };
    } catch (err) {
      // Only a revert is the contract saying no. A network error or a busy RPC
      // is not a rule, so it goes back to the caller as an error.
      const reverted = err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError);
      if (!reverted) throw err;
      const why = explain(err);
      const room = why.rule === "TradeTooLarge" && usdIn ? { maxAmount: Math.floor((s.rules.maxTradeUsd / usdIn) * 1e6) / 1e6 } : {};
      return { allowed: false, ...why, ...sizes, ...room };
    }
  }

  /**
   * What the mandate did on-chain, newest first: trades, deposits, withdrawals,
   * freezes. Refused trades never land on-chain, so they aren't here.
   * Reads backwards in 9,999-block pages (Arc's public RPC refuses wider
   * eth_getLogs) until `limit` events or `maxBlocks` of history.
   */
  async history({ limit = 20, maxBlocks = 400_000, pageDelayMs = 250, retryDelayMs = 800 } = {}) {
    const PAGE = 9_999n;
    const head = await this.publicClient.getBlockNumber({ cacheTime: 0 });
    const tokens = Object.fromEntries(Object.values(await this.tokens()).map((t) => [t.address.toLowerCase(), t]));
    const base = await this._base();
    const sym = (address) => tokens[String(address).toLowerCase()];
    const amountOf = (raw, t) => Number(formatUnits(raw, t?.decimals ?? base.decimals));
    const events = [];
    const stop = head > BigInt(maxBlocks) ? head - BigInt(maxBlocks) : 0n;
    let to = head;
    let from = head;
    let partial = false;
    let first = true;
    while (events.length < limit && to >= stop) {
      from = to > stop + PAGE ? to - PAGE : stop;
      // The public RPC rate-limits bursts of eth_getLogs: pace the pages, back
      // off when refused, and if it keeps refusing, return what was read so far.
      if (!first) await sleep(pageDelayMs);
      first = false;
      let logs = null;
      for (let attempt = 0; attempt < 4 && !logs; attempt++) {
        try {
          logs = await this.publicClient.getLogs({ address: this.address, fromBlock: from, toBlock: to });
        } catch (err) {
          if (!/rate.?limit|limit exceeded|exceeds defined limit|too many requests|\b429\b/i.test(`${err.shortMessage ?? ""} ${err.details ?? ""}`)) throw err;
          await sleep(retryDelayMs * 2 ** attempt);
        }
      }
      if (!logs) {
        partial = true;
        from = to + 1n;
        break;
      }
      for (const log of [...logs].reverse()) {
        let e;
        try {
          e = decodeEventLog({ abi: MANDATE.abi, ...log });
        } catch {
          continue;
        }
        const at = { event: e.eventName, block: Number(log.blockNumber), tx: log.transactionHash };
        if (e.eventName === "Traded") {
          const tIn = sym(e.args.tokenIn);
          const tOut = sym(e.args.tokenOut);
          events.push({
            ...at,
            sold: { symbol: tIn?.symbol ?? e.args.tokenIn, amount: amountOf(e.args.amountIn, tIn) },
            bought: { symbol: tOut?.symbol ?? e.args.tokenOut, amount: amountOf(e.args.amountOut, tOut) },
            equityUsd: amountOf(e.args.equity, base),
          });
        } else if (e.eventName === "Deposited") {
          events.push({ ...at, symbol: base.symbol, amount: amountOf(e.args.amount, base) });
        } else if (e.eventName === "Withdrawn" || e.eventName === "AssetRemoved") {
          const t = sym(e.args.token);
          events.push({ ...at, symbol: t?.symbol ?? e.args.token, amount: amountOf(e.args.amount, t) });
        } else if (e.eventName === "Frozen") {
          events.push({ ...at, equityUsd: amountOf(e.args.equity, base), floorUsd: amountOf(e.args.floor, base) });
        } else if (e.eventName === "Unfrozen") {
          events.push({ ...at, baselineUsd: amountOf(e.args.baseline, base) });
        } else if (e.eventName === "AgentChanged") {
          events.push({ ...at, agent: e.args.agent });
        }
      }
      if (from === 0n || from === stop) break;
      to = from - 1n;
    }
    return { events: events.slice(0, limit), fromBlock: Number(from), toBlock: Number(head), ...(partial ? { partial: true } : {}) };
  }

  /**
   * Push fresh RedStone prices to the feeds a trade will read, so the contract
   * checks it against a price seconds old. A no-op for other feeds. A failed
   * push doesn't stop the trade: the contract still refuses a price older than
   * the mandate allows, and the failure is reported back.
   */
  async refreshPrices(tokens) {
    const feeds = [...new Set(tokens.filter((t) => t.feed).map((t) => t.feed.toLowerCase()))];
    const pushed = [];
    const failed = [];
    for (const feed of feeds) {
      // Arc's public RPC refuses bursts ("exceeds defined limit"); a short
      // backoff usually gets the push through before the trade goes out.
      for (let attempt = 1; ; attempt++) {
        try {
          const hash = await pushPrice({ publicClient: this.publicClient, wallet: this.wallet, feed });
          if (hash) pushed.push(hash);
          break;
        } catch (err) {
          const why = err.shortMessage ?? err.message;
          if (attempt >= PUSH_ATTEMPTS || !/limit|429|too many/i.test(why)) {
            failed.push(`${feed}: ${why}`);
            break;
          }
          await sleep(1500 * attempt);
        }
      }
    }
    return { pushed, failed };
  }

  /**
   * Trade `amount` of `from` into `to`. Returns what arrived, or throws with
   * `err.mandate = { rule, reason }` naming the rule that refused it.
   */
  async trade({ from, to, amount, minOut = "0" }) {
    if (!this.wallet) throw new Error("trading needs the agent's wallet");
    const [tIn, tOut, base] = await Promise.all([this._token(from), this._token(to), this._base()]);
    const prices = await this.refreshPrices([tIn, tOut]);
    const amountIn = parseUnits(String(amount), tIn.decimals);
    const min = parseUnits(String(minOut), tOut.decimals);
    let hash;
    try {
      hash = await this.wallet.writeContract({
        address: this.address,
        abi: TRADE_ABI,
        functionName: "trade",
        args: [tIn.address, tOut.address, amountIn, min],
        account: this.wallet.account,
        chain: this.wallet.chain,
      });
    } catch (err) {
      // Refused before it was ever sent: the simulation hit a rule.
      const e = new Error(`trade refused: ${explain(err).reason}`);
      e.mandate = explain(err);
      e.cause = err;
      throw e;
    }

    // From here the transaction exists. A failure now is not a refusal: the
    // trade may well have happened, so the error carries the hash to check.
    const landed = (message, cause) => {
      const e = new Error(`trade sent (${hash}) but ${message}`);
      e.hash = hash;
      if (cause) e.cause = cause;
      return e;
    };
    let receipt;
    try {
      receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    } catch (err) {
      throw landed(`its receipt couldn't be read: ${err.shortMessage ?? err.message}`, err);
    }
    if (receipt.status !== "success") {
      const e = new Error(`trade refused: the transaction reverted on-chain (${hash})`);
      e.mandate = { rule: "Reverted", reason: "the transaction reverted on-chain" };
      e.hash = hash;
      throw e;
    }
    const traded = receipt.logs
      .filter((l) => l.address.toLowerCase() === this.address.toLowerCase())
      .map((l) => {
        try {
          return decodeEventLog({ abi: MANDATE.abi, ...l });
        } catch {
          return null;
        }
      })
      .find((e) => e?.eventName === "Traded");
    if (!traded) throw landed("no Traded event was found in its receipt");
    return {
      hash,
      sold: { symbol: tIn.symbol, amount: Number(amount) },
      bought: { symbol: tOut.symbol, amount: Number(formatUnits(traded.args.amountOut, tOut.decimals)) },
      equityUsd: Number(formatUnits(traded.args.equity, base.decimals)),
      prices,
    };
  }
}

/**
 * Create a mandate through the factory and optionally fund it.
 * Rules are human-readable; returns the new mandate's address.
 */
export async function createMandate({
  publicClient,
  ownerWallet,
  factory,
  name,
  agent,
  base,
  venue,
  rules,
  assets = [],
  deposit,
}) {
  const baseDecimals = await publicClient.readContract({ address: base, abi: ERC20, functionName: "decimals" });
  const onChainRules = {
    maxTradeValue: parseUnits(String(rules.maxTradeUsd), baseDecimals),
    maxDrawdownBps: Math.round(rules.maxLossPercent * 100),
    maxSlippageBps: Math.round(rules.maxSlippagePercent * 100),
    expiresAt: BigInt(Math.floor(new Date(rules.expiresAt).getTime() / 1000)),
    maxPriceAge: rules.maxPriceAgeSeconds ?? 90_000,
  };
  const send = async (address, abi, functionName, args) => {
    const hash = await ownerWallet.writeContract({
      address,
      abi,
      functionName,
      args,
      account: ownerWallet.account,
      chain: ownerWallet.chain,
    });
    return publicClient.waitForTransactionReceipt({ hash });
  };
  const receipt = await send(factory, FACTORY_ABI, "create", [
    name,
    agent,
    base,
    venue,
    onChainRules,
    assets.map((a) => a.token),
    assets.map((a) => a.feed),
  ]);
  const created = receipt.logs
    .filter((l) => l.address.toLowerCase() === factory.toLowerCase())
    .map((l) => decodeEventLog({ abi: FACTORY.abi, ...l }))
    .find((e) => e.eventName === "MandateCreated");
  const mandate = created.args.mandate;
  if (deposit) {
    const amount = parseUnits(String(deposit), baseDecimals);
    await send(base, ERC20, "approve", [mandate, amount]);
    await send(mandate, MANDATE.abi, "deposit", [amount]);
  }
  return mandate;
}
