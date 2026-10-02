/**
 * Tokenized securities are not plain ERC-20s.
 *
 * Circle has named xStocks and Dinari as issuers bringing tokenized products to
 * Arc. Assets like those are usually transfer-restricted — an allowlist decides
 * who may hold them — and plenty of real tokens (USDT being the famous one)
 * return no data at all from `transfer`, rather than a bool.
 *
 * A Mandate that cannot custody those tokens is useless for the asset class we
 * expect to matter most here. These tests pin down three things:
 *
 *   1. it holds a token that returns nothing;
 *   2. against a restricted token it fails clearly before the mandate is
 *      allowlisted, and works afterwards;
 *   3. one asset becoming untransferable never traps the owner's other money.
 */
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";

import { publicClient, walletFor, account, waitForNode, localChain, expectRevert } from "./helpers.js";
import { artifact } from "../src/artifacts.js";
import { createMandate } from "../src/sdk.js";

const deployer = walletFor(0);
const owner = walletFor(1);
const TOKEN = artifact("MockToken");
const NO_RETURN = artifact("NoReturnToken");
const RESTRICTED = artifact("RestrictedToken");
const M = artifact("Mandate");
const EUR_PRICE = 113_800_000n;

let factory, feed;

async function deploy(name, args = []) {
  const { abi, bytecode } = artifact(name);
  const hash = await deployer.deployContract({ abi, bytecode, args, account: deployer.account, chain: localChain });
  return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress;
}
async function send(wallet, address, abi, functionName, args = []) {
  const hash = await wallet.writeContract({ address, abi, functionName, args, account: wallet.account, chain: localChain });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  return receipt;
}
const chainTime = async () => Number((await publicClient.getBlock()).timestamp);
const balanceOf = (token, abi, who) =>
  publicClient.readContract({ address: token, abi, functionName: "balanceOf", args: [who] });

const rules = async () => ({
  maxTradeUsd: 20,
  maxLossPercent: 10,
  maxSlippagePercent: 1,
  expiresAt: new Date(((await chainTime()) + 7 * 86_400) * 1000),
  maxPriceAgeSeconds: 86_400,
});

before(async () => {
  await waitForNode();
  factory = await deploy("MandateFactory");
  feed = await deploy("MockFeed", [8, EUR_PRICE]);
});

describe("a token that returns no data, like USDT", () => {
  test("can be the mandate's base: deposited, held and withdrawn", async () => {
    const usdt = await deploy("NoReturnToken", ["USDT", 6]);
    const venue = await deploy("OracleVenue", [usdt, 6]);
    await send(deployer, usdt, NO_RETURN.abi, "mint", [account(1).address, 100_000_000n]);

    const mandate = await createMandate({
      publicClient,
      ownerWallet: owner,
      factory,
      name: "holds a non-standard token",
      agent: account(2).address,
      base: usdt,
      venue,
      rules: await rules(),
      assets: [],
      deposit: "50",
    });

    assert.equal(await balanceOf(usdt, NO_RETURN.abi, mandate), 50_000_000n, "the deposit arrived");
    await send(owner, mandate, M.abi, "withdraw", [usdt, 20_000_000n]);
    assert.equal(await balanceOf(usdt, NO_RETURN.abi, mandate), 30_000_000n, "the withdrawal left");
  });
});

describe("a transfer-restricted token, as tokenized equities are", () => {
  async function setup(name) {
    const usdc = await deploy("MockToken", ["USDC", 6]);
    const share = await deploy("RestrictedToken", ["SPYx", 18]);
    const venue = await deploy("OracleVenue", [usdc, 6]);
    await send(deployer, usdc, TOKEN.abi, "mint", [account(1).address, 100_000_000n]);
    await send(deployer, share, RESTRICTED.abi, "setAllowed", [account(1).address, true]);
    await send(deployer, share, RESTRICTED.abi, "mint", [account(1).address, 10n ** 19n]);

    const mandate = await createMandate({
      publicClient,
      ownerWallet: owner,
      factory,
      name,
      agent: account(2).address,
      base: usdc,
      venue,
      rules: await rules(),
      assets: [{ token: share, feed }],
      deposit: "50",
    });
    return { usdc, share, mandate };
  }

  test("refuses the share until the mandate itself is allowlisted, then accepts it", async () => {
    const { share, mandate } = await setup("holds a restricted share");

    // The owner may hold the share; the mandate may not, so sending it in fails.
    await expectRevert(
      send(owner, share, RESTRICTED.abi, "transfer", [mandate, 10n ** 18n]),
      "RestrictedToken: not allowed",
    );

    await send(deployer, share, RESTRICTED.abi, "setAllowed", [mandate, true]);
    await send(owner, share, RESTRICTED.abi, "transfer", [mandate, 10n ** 18n]);
    assert.equal(await balanceOf(share, RESTRICTED.abi, mandate), 10n ** 18n, "the share arrived once allowlisted");

    await send(owner, mandate, M.abi, "withdraw", [share, 10n ** 18n]);
    assert.equal(await balanceOf(share, RESTRICTED.abi, mandate), 0n, "and the owner can take it back");
  });

  test("one frozen asset never traps the owner's other money", async () => {
    const { usdc, share, mandate } = await setup("one asset goes bad");
    await send(deployer, share, RESTRICTED.abi, "setAllowed", [mandate, true]);
    await send(owner, share, RESTRICTED.abi, "transfer", [mandate, 10n ** 18n]);

    // The issuer revokes the mandate's permission: the share can no longer move.
    await send(deployer, share, RESTRICTED.abi, "setAllowed", [mandate, false]);
    await expectRevert(send(owner, mandate, M.abi, "withdraw", [share, 10n ** 18n]), "RestrictedToken: not allowed");

    // The dollars must still come out. An asset the issuer froze is the
    // issuer's doing; it must not become a lock on everything else.
    const before = await balanceOf(usdc, TOKEN.abi, account(1).address);
    await send(owner, mandate, M.abi, "withdraw", [usdc, 50_000_000n]);
    const after = await balanceOf(usdc, TOKEN.abi, account(1).address);
    assert.equal(after - before, 50_000_000n, "the owner got every dollar back");
  });
});
