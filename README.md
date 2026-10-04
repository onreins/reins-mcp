# Reins MCP

**Let any AI agent trade through a Mandate on [Arc](https://arc.io): an MCP server, a JavaScript SDK and a reference agent.**

A Mandate is a smart contract that holds an agent's USDC under rules the agent
can't break: a cap on every trade, a fair-price check against Chainlink, a loss
limit with a public stop-loss, an expiry, and no way to move money out. The
contracts are in [reins-contracts](https://github.com/onreins/reins-contracts).
This repo is how an agent uses one.

The agent never needs to be trusted. It holds only its own trading key, and
the contract decides what that key may do. A trade that breaks a rule is
refused on-chain, and the refusal comes back to the agent as a plain sentence
naming the rule, so it can adjust instead of retrying blindly.

Part of [Reins](https://reins.one) · app at [app.reins.one](https://app.reins.one)

## The MCP server

Ten tools for any MCP client (Claude Desktop, Claude Code, or any agent
framework that speaks MCP). Five run the agent's account:

| Tool | What it does |
|---|---|
| `mandate_status` | Equity in USD, what the Mandate holds, the rules it trades within (max trade size, loss limit, allowed assets, expiry) and how much loss headroom is left |
| `mandate_price` | The Chainlink price for an asset, the one every trade is checked against |
| `mandate_check` | Would this trade go through? The contract simulates it and nothing is sent: what it would receive, or the rule it would break and the largest amount it could trade instead |
| `mandate_trade` | Trade an amount of one asset for another, e.g. `{ "from": "USDC", "to": "EURC", "amount": "5" }` |
| `mandate_history` | Recent on-chain events (trades, deposits, withdrawals, freezes), plus every trade tried this session, including refused ones, which never reach the chain |

Five bring in the rest of the Reins platform, and need no key at all:

| Tool | What it does |
|---|---|
| `markets` | Live markets on Hyperliquid, Binance and Coinbase: price, 24-hour change and volume, funding for perpetuals |
| `hot_list` | This four-hour round's hottest and coolest coins, each with a verdict, a reason, limits sized for its swings and a strategy idea |
| `thesis` | Three readers on one coin (trend, flow, risk), a verdict of hot, watch or cold, and suggested limits |
| `backtest` | A strategy in plain words, turned into rules and tested on real prices since 2021, after fees, against buying and holding |
| `plan_agent` | A deposit and limits, turned into a link to the create page with them filled in. The owner signs it; the AI never can |

A refused trade returns `{ "ok": false, "rule": "TradeTooLarge", "reason": "…" }`
rather than a raw revert, and `mandate_check` tells the agent before it tries.

So one conversation can go from "what's moving?" (`hot_list`) to "test buying
it on a trend" (`backtest`) to "set it up with a 10% loss limit" (`plan_agent`),
and then trade inside the rules (`mandate_check`, `mandate_trade`).

### Research only

Started with no `MANDATE_ADDRESS` and `MANDATE_AGENT_KEY`, the server offers
just the five platform tools. It's a way to try Reins from Claude before
creating an agent:

```json
{ "mcpServers": { "reins": { "command": "node", "args": ["/path/to/reins-mcp/src/mcp-server.js"] } } }
```

### Use it from Claude Desktop

```bash
git clone https://github.com/onreins/reins-mcp && cd reins-mcp && npm install
```

Then add it to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mandate": {
      "command": "node",
      "args": ["/path/to/reins-mcp/src/mcp-server.js"],
      "env": {
        "MANDATE_ADDRESS": "0xYourMandate",
        "MANDATE_AGENT_KEY": "0xTheAgentsTradingKey",
        "MANDATE_NETWORK": "testnet"
      }
    }
  }
}
```

| Setting | |
|---|---|
| `MANDATE_ADDRESS` | The Mandate the agent trades for |
| `MANDATE_AGENT_KEY` | **The agent's own trading key**, never the owner's wallet. The contract refuses to let the owner also be the agent. |
| `MANDATE_NETWORK` | `mainnet` (default) or `testnet` |
| `MANDATE_RPC` | Optional RPC URL; defaults to Arc's public endpoint |
| `REINS_APP_URL` | Optional; where backtests run and plan links point. Defaults to `https://app.reins.one` |

Create a Mandate and its agent key in the app at
[app.reins.one](https://app.reins.one), or with `createMandate` below.

## The SDK

```js
import { MandateClient, createMandate } from "./src/sdk.js";

const mandate = new MandateClient({ publicClient, wallet, address });

await mandate.status();                                   // money, holdings, rules, headroom
await mandate.price("EURC");                              // { usd, updatedAt }
await mandate.trade({ from: "USDC", to: "EURC", amount: "5" });
// → { sold, bought, equityUsd }, or throws with err.mandate = { rule, reason }
```

`publicClient` and `wallet` are [viem](https://viem.sh) clients for Arc; the
wallet holds the agent's key, and reading needs no wallet at all.

`createMandate` creates and funds one through the factory, with rules in plain
units:

```js
const address = await createMandate({
  publicClient, ownerWallet, factory, venue, base: USDC,
  name: "my first agent",
  agent: agentAddress,
  rules: { maxTradeUsd: 2, maxLossPercent: 10, maxSlippagePercent: 1, expiresAt: "2026-12-31" },
  assets: [{ token: EURC, feed: EURC_USD_FEED }],
  deposit: 5,
});
```

## The reference agent

[`examples/fx-reversion.js`](examples/fx-reversion.js) trades EUR/USD
reversion through a Mandate: when EURC is cheap in the Uniswap pool against
Chainlink by more than the pool fee plus a margin, it buys; when rich, it
sells. Every decision is logged with its reason.

```bash
MANDATE_ADDRESS=0x… MANDATE_AGENT_KEY=0x… npm run agent:fx -- --once
```

**It is a worked example, not a profitable strategy.** We measured it on live
Arc mainnet data: over 23.8 hours the pool moved 33.7bp in total, against a
10bp round-trip cost, so every threshold at or above cost fired zero trades.
It's here to show how an agent drives a Mandate, and because its refusals are
what the live testnet run exercised.

Settings: `AGENT_EDGE_BPS` (default 15), `AGENT_TRADE_USD` (default: the
Mandate's limit), `AGENT_INTERVAL_SEC` (default 60).

## Tests

```bash
npm install
npm run chain        # terminal 1: a local node
npm test             # terminal 2: 20 tests
```

They run the MCP server through a real MCP client against freshly deployed
contracts: status, prices and trades; every refusal named instead of dumped as
a raw revert; tokens that return nothing or restrict who may hold them; and the
reference agent's decisions. `compiled/` holds the contract builds the tests
deploy, produced by [reins-contracts](https://github.com/onreins/reins-contracts).

## License

[MIT](LICENSE)
