/**
 * The platform tools: markets, theses, the hot list, backtests and plans,
 * read from the exchanges and the Reins app. No network: fetch is stubbed.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { PlatformClient } from "../src/platform.js";
import { createMandateMcpServer } from "../src/mcp-server.js";
import { APP, stubFetch, stubPlatform } from "./platform.fixtures.js";

describe("platform", () => {
  test("markets searches every venue the way the Charts page does, busiest first", async () => {
    const m = await stubPlatform().markets({ query: "btc" });
    assert.deepEqual(m.markets.map((x) => x.market), ["BTC-PERP", "BTC/USDT", "BTC/USD", "ETH/BTC"]);
    assert.equal(m.markets[0].venue, "hyperliquid");
    assert.equal(m.markets[0].price, 85262);
    assert.ok(Math.abs(m.markets[0].change24hPercent - 0.5) < 0.01);
    assert.deepEqual(m.venues, { hyperliquid: "ok", binance: "ok", coinbase: "ok" });
  });

  test("a venue that's down is reported, and the others still answer", async () => {
    const m = await stubPlatform({ down: ["coinbase"] }).markets({ query: "btc" });
    assert.equal(m.venues.coinbase, "unavailable");
    assert.deepEqual(m.markets.map((x) => x.market), ["BTC-PERP", "BTC/USDT", "ETH/BTC"]);
  });

  test("the hot list puts coins the agents lean towards first, and the ones they lean against apart", async () => {
    const h = await stubPlatform().hotList();
    assert.equal(h.hot[0].market, "PUMP-PERP");
    assert.equal(h.hot[0].verdict, "hot");
    assert.ok(h.cooling.some((x) => x.market === "WLD-PERP"));
    assert.ok(h.round.nextAt > h.round.startedAt);
  });

  test("a thesis reads one coin three ways and suggests limits for it", async () => {
    const t = await stubPlatform().thesis("PUMP");
    assert.equal(t.market, "PUMP-PERP");
    assert.equal(t.verdict, "hot");
    assert.deepEqual(t.reads.map((r) => r.agent), ["Trend", "Flow", "Risk"]);
    assert.ok(t.suggestedLimits.lossPercent >= 5);
    assert.match(t.idea, /^Buy PUMP/);
  });

  test("a thesis for an unknown coin says so", async () => {
    await assert.rejects(stubPlatform().thesis("NOPE"), /no market for "NOPE"/);
  });

  test("backtest sends the words to the strategy chat and returns the result in percent", async () => {
    const calls = [];
    const p = new PlatformClient({ appUrl: APP, fetch: stubFetch({ calls }) });
    const b = await p.backtest("Buy ETH above its 200-day average with a 10% stop");
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.messages[0].content, "Buy ETH above its 200-day average with a 10% stop");
    assert.equal(b.strategy.name, "ETH 200-day trend");
    assert.equal(b.results.returnPercent, 123.4);
    assert.equal(b.results.annualReturnPercent, 15.1);
    assert.equal(b.results.worstDropPercent, -38.1);
    assert.equal(b.buyAndHold.returnPercent, 250);
    assert.equal(b.results.feesIncludedBps, 10);
    assert.equal(b.curve, undefined);
  });

  test("plan_agent turns limits into a create link the owner opens and signs", () => {
    const p = stubPlatform().planAgent({ deposit: 1000, lossPercent: 10, tradePercent: 25, bandPercent: 1, market: "BTC-PERP" });
    assert.equal(p.link, `${APP}/create.html?loss=10&trade=25&band=1&deposit=1000&from=BTC-PERP`);
    assert.equal(p.floorUsd, 900);
    assert.equal(p.maxTradeUsd, 250);
  });
});

describe("research-only MCP server", () => {
  test("with no mandate configured it still offers the platform tools", async () => {
    const server = createMandateMcpServer({ platform: stubPlatform() });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);
    const { tools } = await mcp.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["backtest", "hot_list", "markets", "plan_agent", "thesis"]);
    const res = await mcp.callTool({ name: "hot_list", arguments: {} });
    assert.equal(JSON.parse(res.content[0].text).hot[0].market, "PUMP-PERP");
    await mcp.close();
  });
});
