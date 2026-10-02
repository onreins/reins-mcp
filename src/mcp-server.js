/**
 * Mandate MCP server: give any AI agent money it cannot misuse.
 *
 * Exposes a Mandate to an MCP client (Claude, or any agent framework that
 * speaks MCP) as three tools:
 *
 *   mandate_status   money, holdings, rules and how much loss headroom is left
 *   mandate_price    the oracle price the contract will check trades against
 *   mandate_trade    trade one asset for another, inside the rules
 *
 * The rules live in the contract, not here. A trade that breaks one is refused
 * on-chain, and the refusal comes back to the agent as a plain sentence naming
 * the rule, so it can adjust instead of retrying blindly.
 *
 * Run it (stdio), e.g. from an MCP client config:
 *
 *   MANDATE_ADDRESS=0x…  MANDATE_AGENT_KEY=0x…  MANDATE_NETWORK=mainnet \
 *     node src/mcp-server.js
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

const json = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

/** Build the server around an existing MandateClient (tests pass their own). */
export function createMandateMcpServer({ client }) {
  const server = new McpServer({ name: "mandate", version: "0.1.0" });

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
    async () => json(await client.status()),
  );

  server.registerTool(
    "mandate_price",
    {
      title: "Oracle price",
      description:
        "The Chainlink price for an asset in your mandate. Every trade is checked against this " +
        "price, and fills worse than the mandate's slippage limit are refused.",
      inputSchema: { symbol: z.string().describe("Asset symbol, e.g. EURC") },
    },
    async ({ symbol }) => json({ symbol, ...(await client.price(symbol)) }),
  );

  server.registerTool(
    "mandate_trade",
    {
      title: "Trade",
      description:
        "Trade an amount of one asset in your mandate for another. The mandate contract enforces " +
        "the rules: if a rule would be broken the trade is refused and you get the reason back.",
      inputSchema: {
        from: z.string().describe("Symbol to sell, e.g. USDC"),
        to: z.string().describe("Symbol to buy, e.g. EURC"),
        amount: z
          .string()
          .regex(/^\d+(\.\d+)?$/, "a positive decimal number, e.g. 5 or 2.5")
          .describe("How much of `from` to sell, in whole units (e.g. \"5\" = five dollars)"),
      },
    },
    async ({ from, to, amount }) => {
      try {
        return json({ ok: true, ...(await client.trade({ from, to, amount })) });
      } catch (err) {
        // A refusal is information for the agent, not a crash.
        const refusal = { ok: false, rule: err.mandate?.rule ?? "Error", reason: err.mandate?.reason ?? err.message };
        return { isError: true, content: [{ type: "text", text: JSON.stringify(refusal) }] };
      }
    },
  );

  return server;
}

async function main() {
  const address = process.env.MANDATE_ADDRESS;
  const key = process.env.MANDATE_AGENT_KEY;
  const network = process.env.MANDATE_NETWORK ?? "mainnet";
  if (!isAddress(address ?? "") || !/^0x[0-9a-fA-F]{64}$/.test(key ?? "")) {
    console.error("mandate-mcp: set MANDATE_ADDRESS and MANDATE_AGENT_KEY (and optionally MANDATE_NETWORK, MANDATE_RPC)");
    process.exit(1);
  }
  const chain = network === "testnet" ? arcTestnet : arc;
  const transport = http(process.env.MANDATE_RPC);
  const publicClient = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account: privateKeyToAccount(key), chain, transport });
  const server = createMandateMcpServer({ client: new MandateClient({ publicClient, wallet, address }) });
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; log to stderr only.
  console.error(`mandate-mcp: serving ${address} on ${chain.name}`);
}

const invokedDirectly =
  process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    console.error("mandate-mcp failed:", err.message);
    process.exit(1);
  });
}
