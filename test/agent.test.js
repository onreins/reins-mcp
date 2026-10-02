/**
 * The reference agent's decision logic: pure, no chain, no keys.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { decide } from "../examples/fx-reversion.js";

const base = { oracleUsd: 1.138, usdc: 10, eurc: 0, maxTradeUsd: 10 };

test("holds when the pool is within the fee plus margin of the oracle", () => {
  const d = decide({ ...base, poolUsd: 1.138 * 1.0003 });
  assert.equal(d.action, "hold");
  assert.match(d.reason, /\+3\.0 bps/);
});

test("buys EURC when it's cheap in the pool", () => {
  const d = decide({ ...base, poolUsd: 1.138 * (1 - 0.003) });
  assert.equal(d.action, "buy");
  assert.equal(d.from, "USDC");
  assert.equal(d.amount, "10");
  assert.match(d.reason, /cheap/);
});

test("sells EURC when it's rich in the pool, never more than it holds", () => {
  const d = decide({ ...base, usdc: 0, eurc: 2, poolUsd: 1.138 * 1.003 });
  assert.equal(d.action, "sell");
  assert.equal(Number(d.amount), 2);
});

test("never sizes a trade above the mandate's limit", () => {
  const d = decide({ ...base, usdc: 500, poolUsd: 1.1, maxTradeUsd: 25, tradeUsd: 100 });
  assert.equal(d.amount, "25");
});

test("can't buy with no dollars or sell with no euros", () => {
  assert.equal(decide({ ...base, usdc: 0, poolUsd: 1.0 }).action, "hold");
  assert.equal(decide({ ...base, eurc: 0, poolUsd: 1.3 }).action, "hold");
});

test("a higher required edge makes it more patient", () => {
  const cheap = { ...base, poolUsd: 1.138 * (1 - 0.0025) }; // 25 bps cheap
  assert.equal(decide({ ...cheap, edgeBps: 15 }).action, "buy");
  assert.equal(decide({ ...cheap, edgeBps: 30 }).action, "hold");
});
