/**
 * RedStone prices for mandates: fetch signed packages and push one on-chain.
 *
 *   await pushPrice({ publicClient, wallet, feed });   // before a trade
 *
 * A RedStonePriceFeed only moves when someone brings it a fresh signed price
 * (see RedStonePriceFeed.sol in onreins/reins-contracts). Every trading path calls pushPrice
 * just before it trades, so the contract checks the fill against a price
 * seconds old. Anyone may push; the contract trusts the signatures, not the
 * sender. Feeds that aren't RedStone feeds (Chainlink, PinnedFeed) are left
 * alone, so the same code runs against either.
 *
 * No RedStone SDK: it pulls in ethers v5 and packages with open advisories.
 * The payload format is small and fixed (RedStone's protocol package), so it
 * is built here with viem, and each package's signature is checked against
 * the production signers before it's used. The contract checks them again.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  concatHex,
  encodeFunctionData,
  hexToString,
  keccak256,
  numberToHex,
  parseAbi,
  parseUnits,
  recoverAddress,
  stringToHex,
  toHex,
} from "viem";

export const REDSTONE_SERVICE = "redstone-primary-prod";

/** The "redstone-primary-prod" signers, the same five the contract trusts. */
export const REDSTONE_SIGNERS = [
  "0x8BB8F32Df04c8b654987DAaeD53D6B6091e3B774",
  "0xdEB22f54738d54976C4c0fe5ce6d408E40d88499",
  "0x51Ce04Be4b3E32572C4Ec9135221d0691Ba7d202",
  "0xDD682daEC5A90dD295d14DA4b0bec9281017b5bE",
  "0x9c5AE89C4Af6aA32cE58588DBaF90d18a855B6de",
].map((a) => a.toLowerCase());

/** The signers a payload carries; the contract requires the same 3 of 5. */
const SIGNERS_NEEDED = 3;
const GATEWAYS = ["https://oracle-gateway-1.a.redstone.finance", "https://oracle-gateway-2.a.redstone.finance"];
const MARKER = "0x000002ed57011e0000";

export const REDSTONE_FEED_ABI = parseAbi([
  "function dataFeedId() view returns (bytes32)",
  "function updatePrice() returns (int256 answer, uint256 updatedAt)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);

const feedIds = new Map(); // feed address -> RedStone id, or null for other feeds

/** The RedStone data feed a contract reads ("EUROC"), or null if it isn't a RedStone feed. */
export async function redstoneFeedId(publicClient, feed) {
  const key = feed.toLowerCase();
  if (!feedIds.has(key)) {
    try {
      const raw = await publicClient.readContract({ address: feed, abi: REDSTONE_FEED_ABI, functionName: "dataFeedId" });
      feedIds.set(key, hexToString(raw, { size: 32 }).replace(/\0+$/, ""));
    } catch (err) {
      // Only the contract itself saying no (it has no dataFeedId) means "not a
      // RedStone feed". A busy or failing RPC is passed on and never cached,
      // or one hiccup would stop every later push to this feed.
      const notRedStone =
        err instanceof BaseError &&
        err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError);
      if (!notRedStone) throw err;
      feedIds.set(key, null);
    }
  }
  return feedIds.get(key);
}

// ------------------------------------------------------------- the format

const feedIdBytes32 = (id) => (id.length > 31 ? keccak256(stringToHex(id)) : stringToHex(id, { size: 32 }));

/** A numeric value as RedStone writes it: fixed to its decimals, as a 32-byte integer. */
function valueBytes(point) {
  if (typeof point.value !== "number") return toHex(Buffer.from(point.value, "base64"));
  const decimals = point.decimals ?? 8;
  let text = Number(point.value).toFixed(decimals);
  if (text.includes("e")) text = Number(text).toLocaleString("fullwide", { useGrouping: false });
  return numberToHex(parseUnits(text, decimals), { size: 32 });
}

/** A package's signed bytes: its data points (sorted by feed id), timestamp, value size and count. */
function packageBytes(pkg) {
  const points = pkg.dataPoints
    .map((p) => ({ id: feedIdBytes32(p.dataFeedId), value: valueBytes(p) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const size = (points[0].value.length - 2) / 2;
  return concatHex([
    ...points.flatMap((p) => [p.id, p.value]),
    numberToHex(pkg.timestampMilliseconds, { size: 6 }),
    numberToHex(size, { size: 4 }),
    numberToHex(points.length, { size: 3 }),
  ]);
}

const signatureHex = (sig) => (sig.startsWith("0x") ? sig : toHex(Buffer.from(sig, "base64")));

/** The address that signed a gateway package (its signature over keccak256 of the package). */
export async function packageSigner(pkg) {
  return (await recoverAddress({ hash: keccak256(packageBytes(pkg)), signature: signatureHex(pkg.signature) })).toLowerCase();
}

/** The payload RedStone's contracts read from the end of calldata, as hex without 0x. */
export function payloadHex(packages) {
  const body = packages.map((pkg) => concatHex([packageBytes(pkg), signatureHex(pkg.signature)]));
  // Packages, their count (2 bytes), unsigned metadata (none) and its size (3 bytes), the marker.
  return concatHex([...body, numberToHex(packages.length, { size: 2 }), numberToHex(0, { size: 3 }), MARKER]).slice(2);
}

/**
 * Pick the packages to send: from authorised signers only, all with the same
 * (newest) timestamp, as the contract requires, and the SIGNERS_NEEDED whose
 * values sit closest to the median, so the price pushed is the honest middle.
 */
export async function choosePackages(packages, dataFeedId) {
  const checked = [];
  for (const pkg of packages ?? []) {
    const point = pkg.dataPoints?.find((p) => p.dataFeedId === dataFeedId);
    if (!point || typeof point.value !== "number") continue;
    const signer = await packageSigner(pkg).catch(() => null);
    if (signer && REDSTONE_SIGNERS.includes(signer)) checked.push({ pkg, signer, value: point.value });
  }
  const newest = Math.max(...checked.map((c) => c.pkg.timestampMilliseconds));
  const same = checked.filter((c) => c.pkg.timestampMilliseconds === newest);
  const bySigner = [...new Map(same.map((c) => [c.signer, c])).values()];
  if (bySigner.length < SIGNERS_NEEDED) {
    throw new Error(`RedStone returned ${bySigner.length} valid signed ${dataFeedId} prices; ${SIGNERS_NEEDED} are needed`);
  }
  const sorted = [...bySigner].sort((a, b) => a.value - b.value);
  const median = sorted[Math.floor(sorted.length / 2)].value;
  return sorted
    .sort((a, b) => Math.abs(a.value - median) - Math.abs(b.value - median))
    .slice(0, SIGNERS_NEEDED)
    .map((c) => c.pkg);
}

/** The latest signed packages for a feed from RedStone's gateways, first that answers. */
async function fetchPackages(dataFeedId, { fetch: get = globalThis.fetch } = {}) {
  let lastError;
  for (const gateway of GATEWAYS) {
    try {
      const res = await get(`${gateway}/v2/data-packages/latest/${REDSTONE_SERVICE}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`${gateway} answered ${res.status}`);
      const body = await res.json();
      if (body[dataFeedId]?.length) return body[dataFeedId];
      throw new Error(`${gateway} has no ${dataFeedId} prices`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** The latest signed payload for a feed, as hex to append to calldata. */
export async function signedPayload(dataFeedId, { request, fetch } = {}) {
  if (request) return request({ dataServiceId: REDSTONE_SERVICE, dataPackagesIds: [dataFeedId], uniqueSignersCount: SIGNERS_NEEDED });
  return payloadHex(await choosePackages(await fetchPackages(dataFeedId, { fetch }), dataFeedId));
}

/** The updatePrice() calldata with a payload on the end, where RedStone's contract reads it. */
export function updateCalldata(payload) {
  return encodeFunctionData({ abi: REDSTONE_FEED_ABI, functionName: "updatePrice" }) + payload.replace(/^0x/, "");
}

/**
 * Push the latest signed price to a RedStone feed. Returns the transaction
 * hash, or null when the feed isn't a RedStone feed (nothing to do).
 */
export async function pushPrice({ publicClient, wallet, feed, request, fetch }) {
  const id = await redstoneFeedId(publicClient, feed);
  if (!id) return null;
  const data = updateCalldata(await signedPayload(id, { request, fetch }));
  const hash = await wallet.sendTransaction({ to: feed, data, account: wallet.account, chain: wallet.chain });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`the price update reverted (${hash})`);
  return hash;
}
