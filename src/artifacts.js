/** Load a compiled contract ({ abi, bytecode }) shipped in compiled/, built from reins-contracts. */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "compiled");
const cache = new Map();

export function artifact(name) {
  if (!cache.has(name)) cache.set(name, JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")));
  return cache.get(name);
}
