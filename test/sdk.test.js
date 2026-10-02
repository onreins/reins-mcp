/**
 * The Mandate SDK and MCP server, end to end on a local chain.
 *
 * The MCP half is exercised the way an AI agent would use it: a real MCP
 * client, connected to the server, calling the tools. A refused trade must
 * come back as a sentence naming the rule, not as a crash.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { publicClient, walletFor, account, waitForNode, localChain } from "./helpers.js";
import { artifact } from "../src/artifacts.js";
import { MandateClient, createMandate } from "../src/sdk.js";
import { createMandateMcpServer } from "../src/mcp-server.js";

const deployer = walletFor(0);
const owner = walletFor(1);
const agent = walletFor(2);
const TOKEN = artifact("MockToken");
const VENUE = artifact("OracleVenue");
const FEED = artifact("MockFeed");
const EUR_PRICE = 113_800_000n; // $1.138, 8 decimals

let usdc, eurc, feed, venue, factory, mandate, sdk, mcp;

async function deploy(name, args = []) {
  const { abi, bytecode } = artifact(name);
  const hash = await deployer.deployContract({ abi, bytecode, args, account: deployer.account, chain: localChain });
  return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress;
}
async function send(wallet, address, abi, functionName, args = []) {
  const hash = await wallet.writeContract({ address, abi, functionName, args, account: wallet.account, chain: localChain });
  return publicClient.waitForTransactionReceipt({ hash });
}
const chainTime = async () => Number((await publicClient.getBlock()).timestamp);
const freshPrice = () => send(deployer, feed, FEED.abi, "set", [EUR_PRICE]);

before(async () => {
  await waitForNode();
  usdc = await deploy("MockToken", ["USDC", 6]);
  eurc = await deploy("MockToken", ["EURC", 6]);
  feed = await deploy("MockFeed", [8, EUR_PRICE]);
  venue = await deploy("OracleVenue", [usdc, 6]);
  await send(deployer, venue, VENUE.abi, "list", [eurc, feed, 6]);
  await send(deployer, usdc, TOKEN.abi, "mint", [venue, 10_000_000_000n]);
  await send(deployer, eurc, TOKEN.abi, "mint", [venue, 10_000_000_000n]);
  factory = await deploy("MandateFactory");
  await send(deployer, usdc, TOKEN.abi, "mint", [account(1).address, 100_000_000n]);

  mandate = await createMandate({
    publicClient,
    ownerWallet: owner,
    factory,
    name: "fx agent",
    agent: account(2).address,
    base: usdc,
    venue,
    rules: {
      maxTradeUsd: 10,
      maxLossPercent: 5,
      maxSlippagePercent: 1,
      expiresAt: new Date(((await chainTime()) + 7 * 86_400) * 1000),
      maxPriceAgeSeconds: 86_400,
    },
    assets: [{ token: eurc, feed }],
    deposit: "50",
  });
  sdk = new MandateClient({ publicClient, wallet: agent, address: mandate });

  const server = createMandateMcpServer({ client: sdk });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  mcp = new Client({ name: "test-agent", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);
});

after(async () => {
  await mcp?.close();
});

describe("SDK", () => {
  test("createMandate funds it and status reads it back in plain terms", async () => {
    await freshPrice();
    const s = await sdk.status();
    assert.equal(s.equityUsd, 50);
    assert.deepEqual(s.rules, {
      maxTradeUsd: 10,
      maxLossPercent: 5,
      maxSlippagePercent: 1,
      maxPriceAgeSeconds: 86_400,
      allowedAssets: ["USDC", "EURC"],
    });
    assert.equal(s.floorUsd, 47.5);
    assert.equal(s.lossHeadroomUsd, 2.5);
  });

  test("trade by symbol and human amount, and see what arrived", async () => {
    await freshPrice();
    const r = await sdk.trade({ from: "USDC", to: "EURC", amount: "5" });
    assert.equal(r.bought.symbol, "EURC");
    assert.ok(Math.abs(r.bought.amount - 5 / 1.138) < 1e-5, `got ${r.bought.amount}`);
    // 5 / 1.138 isn't exact; the exchange rounds its output down by at most a unit.
    assert.ok(Math.abs(r.equityUsd - 50) <= 0.000001, `equity ${r.equityUsd}`);
  });

  test("a rule violation comes back as a named rule and a reason", async () => {
    await freshPrice();
    await assert.rejects(sdk.trade({ from: "USDC", to: "EURC", amount: "25" }), (err) => {
      assert.equal(err.mandate.rule, "TradeTooLarge");
      assert.match(err.mandate.reason, /per-trade limit/);
      return true;
    });
  });

  test("an asset outside the mandate is refused before anything is sent", async () => {
    await assert.rejects(sdk.trade({ from: "USDC", to: "DOGE", amount: "1" }), /not in this mandate/);
  });

  test("an exchange that cannot beat the mandate's price floor is named, not dumped as a raw revert", async () => {
    // On Arc the refusal comes from UniswapV4Venue's own error, not from the
    // Mandate, because the venue is handed the oracle floor as its minimum.
    // An agent still has to be told what happened in words it can act on.
    const stingy = await deploy("StingyVenue");
    const refusing = await createMandate({
      publicClient,
      ownerWallet: owner,
      factory,
      name: "fx agent on a thin pool",
      agent: account(2).address,
      base: usdc,
      venue: stingy,
      rules: {
        maxTradeUsd: 10,
        maxLossPercent: 5,
        maxSlippagePercent: 1,
        expiresAt: new Date(((await chainTime()) + 7 * 86_400) * 1000),
        maxPriceAgeSeconds: 86_400,
      },
      assets: [{ token: eurc, feed }],
      deposit: "10",
    });

    await freshPrice();
    const client = new MandateClient({ publicClient, wallet: agent, address: refusing });
    await assert.rejects(client.trade({ from: "USDC", to: "EURC", amount: "1" }), (err) => {
      assert.equal(err.mandate.rule, "InsufficientOutput");
      assert.match(err.mandate.reason, /worse price than the mandate allows/);
      return true;
    });
  });
});

describe("MCP server", () => {
  const body = (res) => JSON.parse(res.content[0].text);

  test("lists the three tools an agent needs", async () => {
    const { tools } = await mcp.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["mandate_price", "mandate_status", "mandate_trade"]);
  });

  test("an agent can read its rules and headroom", async () => {
    await freshPrice();
    const s = body(await mcp.callTool({ name: "mandate_status", arguments: {} }));
    assert.equal(s.rules.maxTradeUsd, 10);
    assert.ok(s.lossHeadroomUsd > 0);
  });

  test("an agent can trade within the rules", async () => {
    await freshPrice();
    const res = await mcp.callTool({ name: "mandate_trade", arguments: { from: "USDC", to: "EURC", amount: "3" } });
    assert.ok(!res.isError, JSON.stringify(res.content));
    assert.equal(body(res).ok, true);
  });

  test("a refused trade tells the agent which rule and why", async () => {
    await freshPrice();
    const res = await mcp.callTool({ name: "mandate_trade", arguments: { from: "USDC", to: "EURC", amount: "11" } });
    assert.equal(res.isError, true);
    assert.equal(body(res).ok, false);
    assert.equal(body(res).rule, "TradeTooLarge");
  });

  test("a malformed amount is rejected by the tool's schema", async () => {
    const res = await mcp.callTool({ name: "mandate_trade", arguments: { from: "USDC", to: "EURC", amount: "-5" } });
    assert.equal(res.isError, true);
  });

  test("the price tool returns the oracle price the contract checks against", async () => {
    await freshPrice();
    const p = body(await mcp.callTool({ name: "mandate_price", arguments: { symbol: "EURC" } }));
    assert.equal(p.usd, 1.138);
  });
});
