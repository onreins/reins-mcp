/**
 * Reins MCP server: give any AI agent money it cannot misuse, and the platform
 * to decide what to do with it.
 *
 * With a mandate configured, the agent gets its account:
 *
 *   mandate_status    money, holdings, rules and how much loss headroom is left
 *   mandate_price     the oracle price the contract will check trades against
 *   mandate_check     would this trade go through? simulated, nothing sent
 *   mandate_trade     trade one asset for another, inside the rules
 *   mandate_history   what it did on-chain, and what was refused this session
 *
 * Always, it gets the platform (no key needed):
 *
 *   markets           live markets on Hyperliquid, Binance and Coinbase
 *   hot_list          this round's hot and cooling coins, with a thesis each
 *   thesis            three reads on one coin, and limits sized for its swings
 *   backtest          a strategy in plain words, tested on real prices
 *   plan_agent        limits turned into a create link the owner signs
 *
 * The rules live in the contract, not here. A trade that breaks one is refused
 * on-chain, and the refusal comes back to the agent as a plain sentence naming
 * the rule, so it can adjust instead of retrying blindly.
 *
 * Run it (stdio), e.g. from an MCP client config:
 *
 *   MANDATE_ADDRESS=0x…  MANDATE_AGENT_KEY=0x…  MANDATE_NETWORK=testnet \
 *     node src/mcp-server.js
 *
 * With neither set it runs research-only: the platform tools, no trading.
 */
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createPublicClient, createWalletClient, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc, arcTestnet } from "viem/chains";

import { MandateClient } from "./sdk.js";
import { PlatformClient } from "./platform.js";

const json = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
/** An error in a few words. Any URL is cut back to its host: a path or query can carry an RPC API key. */
const say = (err) => {
  let text = String(err?.shortMessage ?? err?.message ?? err).slice(0, 500);
  const rpc = process.env.MANDATE_RPC;
  if (rpc) text = text.split(rpc).join("<rpc>");
  return text.replace(/(https?:\/\/[^/\s"'<>]+)[^\s"'<>]*/g, "$1/…");
};
const failure = (err) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: say(err) }) }] });
/** Run a tool, turning a thrown error into a message the agent can read. */
const safely = (fn) => async (args) => {
  try {
    return json(await fn(args));
  } catch (err) {
    return failure(err);
  }
};

const symbolSchema = z.string().trim().min(1).max(32);
const amountSchema = z
  .string()
  .max(40)
  .regex(/^(?=.*[1-9])\d{1,24}(\.\d{1,18})?$/, "a positive decimal number, e.g. 5 or 2.5")
  .describe("How much of `from` to sell, in whole units (e.g. \"5\" = five dollars)");

const INSTRUCTIONS =
  "Reins gives you a trading account whose rules are enforced by a smart contract: a cap on each trade, " +
  "a loss limit that freezes the account, a fair-price check against an oracle, and a list of allowed assets. " +
  "Read mandate_status first. Call mandate_check before mandate_trade, and size trades to what it allows. " +
  "If a trade is refused, the reason names the rule; adjust rather than retry. " +
  "For ideas, use hot_list, thesis and markets; to test one, backtest; to propose a new agent, plan_agent " +
  "(the owner signs the link, you never create or fund agents yourself).";

function registerMandateTools(server, client) {
  // Refused trades never reach the chain, so the server keeps its own note of
  // them: the latest 200 tries, so a looping agent can't grow it forever.
  const session = [];
  const note = (entry) => {
    session.push(entry);
    if (session.length > 200) session.shift();
  };

  server.registerTool(
    "mandate_status",
    {
      title: "Mandate status",
      description:
        "Read your mandate: equity in USD, what you hold, the rules you must trade within " +
        "(max trade size, loss limit, allowed assets, expiry) and how much loss headroom is left. " +
        "Check this before trading.",
      inputSchema: {},
    },
    safely(() => client.status()),
  );

  server.registerTool(
    "mandate_price",
    {
      title: "Oracle price",
      description:
        "The Chainlink price for an asset in your mandate. Every trade is checked against this " +
        "price, and fills worse than the mandate's slippage limit are refused.",
      inputSchema: { symbol: symbolSchema.describe("Asset symbol, e.g. EURC") },
    },
    safely(async ({ symbol }) => ({ symbol, ...(await client.price(symbol)) })),
  );

  server.registerTool(
    "mandate_check",
    {
      title: "Check a trade",
      description:
        "Ask the contract whether a trade would go through, without sending it. Returns what you'd receive, " +
        "or the rule it would break and why, plus the trade's size against your cap and, if it's too big, " +
        "the largest amount you could trade instead. Use it before mandate_trade.",
      inputSchema: {
        from: symbolSchema.describe("Symbol to sell, e.g. USDC"),
        to: symbolSchema.describe("Symbol to buy, e.g. EURC"),
        amount: amountSchema,
      },
    },
    safely(({ from, to, amount }) => client.check({ from, to, amount })),
  );

  server.registerTool(
    "mandate_trade",
    {
      title: "Trade",
      description:
        "Trade an amount of one asset in your mandate for another. The mandate contract enforces " +
        "the rules: if a rule would be broken the trade is refused and you get the reason back.",
      inputSchema: {
        from: symbolSchema.describe("Symbol to sell, e.g. USDC"),
        to: symbolSchema.describe("Symbol to buy, e.g. EURC"),
        amount: amountSchema,
      },
    },
    async ({ from, to, amount }) => {
      const at = new Date().toISOString();
      try {
        const done = await client.trade({ from, to, amount });
        note({ at, ok: true, from, to, amount, hash: done.hash });
        return json({ ok: true, ...done });
      } catch (err) {
        // Sent, but its receipt couldn't be read: it may well have filled. Say so,
        // with the hash, so the agent checks before trying again.
        if (err.hash && !err.mandate) {
          const unsure = { ok: null, status: "sent, unconfirmed", hash: err.hash, reason: say(err) };
          note({ at, from, to, amount, ...unsure });
          return { isError: true, content: [{ type: "text", text: JSON.stringify(unsure) }] };
        }
        // A refusal is information for the agent, not a crash.
        const refusal = { ok: false, rule: err.mandate?.rule ?? "Error", reason: err.mandate?.reason ?? say(err) };
        note({ at, from, to, amount, ...refusal });
        return { isError: true, content: [{ type: "text", text: JSON.stringify(refusal) }] };
      }
    },
  );

  server.registerTool(
    "mandate_history",
    {
      title: "History",
      description:
        "What your mandate has done: recent on-chain events, newest first (trades, deposits, withdrawals, " +
        "freezes), and every trade tried through this server this session, including refused ones, " +
        "which never reach the chain.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional().describe("How many on-chain events, default 20") },
    },
    safely(async ({ limit }) => {
      const onChain = await client.history({ limit: limit ?? 20 });
      return {
        onChain: onChain.events,
        scannedBlocks: { from: onChain.fromBlock, to: onChain.toBlock },
        ...(onChain.partial ? { partial: "the chain's public RPC was busy, so older events may be missing; ask again shortly" } : {}),
        thisSession: [...session].reverse(),
      };
    }),
  );
}

function registerPlatformTools(server, platform) {
  server.registerTool(
    "markets",
    {
      title: "Markets",
      description:
        "Live markets on Hyperliquid (perpetuals), Binance and Coinbase (spot): price, 24-hour change and volume, " +
        "and funding for perpetuals. Search by coin or pair (\"ETH\", \"SOL/USDC\"), busiest first.",
      inputSchema: {
        query: z.string().max(40).optional().describe("A coin or pair, e.g. ETH or BTC/USDT; empty for the busiest markets"),
        venue: z.enum(["all", "hyperliquid", "binance", "coinbase"]).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    safely((args) => platform.markets(args)),
  );

  server.registerTool(
    "hot_list",
    {
      title: "Hot list",
      description:
        "This four-hour round's hottest and coolest coins across the three exchanges. Each comes with a verdict, " +
        "a one-line reason, limits sized for its swings, and a strategy idea in plain words you can backtest.",
      inputSchema: { limit: z.number().int().min(1).max(20).optional() },
    },
    safely((args) => platform.hotList(args)),
  );

  server.registerTool(
    "thesis",
    {
      title: "Thesis",
      description:
        "Three readers on one coin: trend (momentum), flow (volume and funding) and risk (how big its swings are), " +
        "a verdict of hot, watch or cold, suggested limits, and a strategy idea. Give a coin (ETH), a pair " +
        "(ETH/USDC), a perpetual (ETH-PERP) or an id (binance:ETHUSDT).",
      inputSchema: { symbol: z.string().trim().min(1).max(40).describe("e.g. ETH, SOL/USDC, BTC-PERP") },
    },
    safely(({ symbol }) => platform.thesis(symbol)),
  );

  server.registerTool(
    "backtest",
    {
      title: "Backtest a strategy",
      description:
        "Describe a strategy in plain words (\"buy ETH when it's above its 200-day average, sell on a 10% drop\"). " +
        "Reins turns it into strict rules and tests it on real daily prices since 2021, after fees, against " +
        "buying and holding. Past results only.",
      inputSchema: {
        strategy: z.string().min(8).max(600).describe("The strategy in plain words"),
        from: z.string().max(10).optional().describe("Start of the test, e.g. 2024 or 2021 (default 2021)"),
      },
    },
    safely(({ strategy, from }) => platform.backtest(strategy, { from })),
  );

  server.registerTool(
    "plan_agent",
    {
      title: "Plan an agent",
      description:
        "Propose a new Reins agent: a deposit and its limits (loss limit that freezes it, largest single trade " +
        "as a share of the deposit, price band around the oracle). Returns a link to the create page with them " +
        "filled in. The owner opens it and signs in their own wallet; you can't create or fund an agent yourself.",
      inputSchema: {
        deposit: z.number().positive().describe("USDC to start with"),
        lossPercent: z.number().min(1).max(60).describe("Freeze after losing this much, e.g. 10"),
        tradePercent: z.number().min(5).max(100).describe("Largest single trade, as a % of the deposit"),
        bandPercent: z.number().min(0.1).max(5).optional().describe("Refuse fills this far from the oracle price, default 1"),
        market: z.string().max(40).optional().describe("The market it was planned on, e.g. ETH-PERP"),
      },
    },
    safely(async (args) => platform.planAgent(args)),
  );
}

/** Build the server. Tests pass their own clients; either half can be left out. */
export function createMandateMcpServer({ client, platform } = {}) {
  const server = new McpServer({ name: "reins", version: "1.1.0" }, { instructions: INSTRUCTIONS });
  if (client) registerMandateTools(server, client);
  if (platform) registerPlatformTools(server, platform);
  return server;
}

async function main() {
  const address = process.env.MANDATE_ADDRESS;
  const key = process.env.MANDATE_AGENT_KEY;
  const network = process.env.MANDATE_NETWORK ?? "mainnet";
  const platform = new PlatformClient({ appUrl: process.env.REINS_APP_URL ?? "https://app.reins.one" });

  let client;
  if (address || key) {
    if (!isAddress(address ?? "") || !/^0x[0-9a-fA-F]{64}$/.test(key ?? "")) {
      console.error("reins-mcp: set both MANDATE_ADDRESS and MANDATE_AGENT_KEY (or neither, for research only)");
      process.exit(1);
    }
    const chain = network === "testnet" ? arcTestnet : arc;
    // Arc's public RPC rate-limits bursts; back off and retry like the Reins app does.
    const transport = http(process.env.MANDATE_RPC, { retryCount: 3, retryDelay: 600 });
    const publicClient = createPublicClient({ chain, transport });
    const wallet = createWalletClient({ account: privateKeyToAccount(key), chain, transport });
    client = new MandateClient({ publicClient, wallet, address });
  }

  const server = createMandateMcpServer({ client, platform });
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; log to stderr only.
  console.error(client ? `reins-mcp: serving ${address} on ${network}` : "reins-mcp: research only (no mandate configured)");
}

const invokedDirectly =
  process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    console.error("reins-mcp failed:", err.message);
    process.exit(1);
  });
}
