#!/usr/bin/env node
/**
 * POST one transaction to Custos /check and print the action to take.
 * Custos does not sign. This script does not accept a key or a seed.
 *
 * node scripts/check.mjs --chain 56 --from 0x... --to 0x... --data 0x --value 0
 * CUSTOS_API_URL overrides the default https://api.custosprotocol.com
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const API = (process.env.CUSTOS_API_URL || "https://api.custosprotocol.com").replace(/\/$/, "");
const FIELDS = new Set(["chainId", "from", "to", "data", "value"]);
const SECRET = new Set([
  "privatekey",
  "private_key",
  "seed",
  "mnemonic",
  "secret",
  "seedphrase",
  "seed_phrase",
]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) fail(`Unknown argument ${arg}.`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for --${key}.`);
    out[key] = value;
    i += 1;
  }
  return out;
}

export function actionFor(body) {
  if (!body || typeof body.verdict !== "string" || typeof body.complete !== "boolean") return "error";
  if (body.verdict === "danger") return "block";
  if (body.verdict === "warn" || body.complete === false) return "warn";
  if (body.verdict === "safe" && body.complete === true) return "allow";
  return "warn";
}

function assertBody(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("Body must be a JSON object.");
  for (const key of Object.keys(payload)) {
    const normalized = key.toLowerCase().replaceAll("-", "_");
    if (SECRET.has(normalized)) fail("Custos does not accept a key or a seed, and it never signs.");
    if (!FIELDS.has(key)) fail(`Unknown field ${key}.`);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return chunks.join("");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let payload;
  if (args.chain !== undefined || args.from !== undefined || args.to !== undefined) {
    const chainId = Number(args.chain);
    payload = {
      chainId,
      from: args.from,
      to: args.to,
      data: args.data ?? "0x",
      value: args.value ?? "0",
    };
  } else {
    const text = await readStdin();
    if (!text.trim()) fail("Pass --chain, --from, --to, --data, and --value, or pipe a JSON body.");
    try {
      payload = JSON.parse(text);
    } catch {
      fail("Body must be JSON.");
    }
  }
  assertBody(payload);
  const response = await fetch(`${API}/check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    fail("Check failed.");
  }
  if (!response.ok) {
    fail(body && typeof body.error === "string" ? body.error : "Check failed.");
  }
  const action = actionFor(body);
  if (action === "error") fail("The check response was not in the expected shape.");
  console.log(JSON.stringify({
    action,
    verdict: body.verdict,
    complete: body.complete,
    reasons: body.reasons,
    providers: body.providers,
  }, null, 2));
  process.exit(action === "allow" ? 0 : action === "warn" ? 2 : 3);
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((err) => {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") fail("Check timed out. Do not sign.");
    fail(err instanceof Error ? err.message : "Check failed.");
  });
}
