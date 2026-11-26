/** Live Custos API. Override with CUSTOS_API_URL for a local worker. */
export const PRODUCTION_API_URL = "https://api.custosprotocol.com";

const CHECK_FIELDS = new Set(["chainId", "from", "to", "data", "value"]);
const SECRET_FIELDS = new Set([
  "privatekey",
  "private_key",
  "seed",
  "mnemonic",
  "secret",
  "seedphrase",
  "seed_phrase",
]);

export type ChainId = 56 | 97 | 8453;

export interface CheckInput {
  chainId: ChainId;
  from: string;
  to: string;
  data: string;
  value: string;
}

export interface Reason {
  code: string;
  severity: string;
  message: string;
}

export interface Providers {
  goplus: string;
  honeypot: string;
  scamSniffer: string;
  registry: string;
}

export interface CheckResult {
  verdict: string;
  complete: boolean;
  reasons: Reason[];
  providers: Providers;
  explanation: string;
}

export interface ReportResult {
  address: string;
  chainId: ChainId;
  configured: boolean;
  reportCount: string;
  reasons: {
    drainer: string;
    honeypot: string;
    phishing: string;
    mintOrRug: string;
    other: string;
  };
  message?: string;
}

export interface RequestOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export function apiBase(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CUSTOS_API_URL?.trim();
  return (configured && configured.length > 0 ? configured : PRODUCTION_API_URL).replace(/\/$/, "");
}

export async function checkTransaction(input: unknown, options: RequestOptions = {}): Promise<CheckResult> {
  const tx = parseCheckInput(input);
  const base = options.baseUrl ?? apiBase(options.env);
  const response = await (options.fetch ?? fetch)(`${base}/check`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "custosprotocol-mcp/0.1.0",
    },
    body: JSON.stringify(tx),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await readJson(response, "Check failed.");
  return parseCheckResult(payload);
}

export async function lookupReport(
  address: unknown,
  chainId: unknown = 97,
  options: RequestOptions = {},
): Promise<ReportResult> {
  const target = addressField(address, "address");
  const chain = chainField(chainId);
  const base = options.baseUrl ?? apiBase(options.env);
  const response = await (options.fetch ?? fetch)(`${base}/report/${target}?chainId=${chain}`, {
    headers: {
      accept: "application/json",
      "user-agent": "custosprotocol-mcp/0.1.0",
    },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await readJson(response, "Registry lookup failed.");
  return parseReportResult(payload);
}

export function parseCheckInput(input: unknown): CheckInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Body must be a JSON object.");
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const normalized = key.toLowerCase().replaceAll("-", "_");
    if (SECRET_FIELDS.has(normalized)) throw new Error("Custos does not accept a key or a seed, and it never signs.");
    if (!CHECK_FIELDS.has(key)) throw new Error(`Unknown field ${key}.`);
  }
  return {
    chainId: chainField(record.chainId),
    from: addressField(record.from, "from"),
    to: addressField(record.to, "to"),
    data: dataField(record.data),
    value: valueField(record.value),
  };
}

function parseCheckResult(value: unknown): CheckResult {
  if (!value || typeof value !== "object") throw new Error("The check response was not in the expected shape.");
  const body = value as Record<string, unknown>;
  if (typeof body.verdict !== "string" || typeof body.complete !== "boolean" || typeof body.explanation !== "string") {
    throw new Error("The check response was not in the expected shape.");
  }
  if (!Array.isArray(body.reasons) || !body.providers || typeof body.providers !== "object") {
    throw new Error("The check response was not in the expected shape.");
  }
  const providers = body.providers as Record<string, unknown>;
  for (const key of ["goplus", "honeypot", "scamSniffer", "registry"] as const) {
    if (typeof providers[key] !== "string") throw new Error("The check response was not in the expected shape.");
  }
  const reasons: Reason[] = [];
  for (const item of body.reasons) {
    if (!item || typeof item !== "object") continue;
    const reason = item as Record<string, unknown>;
    if (typeof reason.code !== "string" || typeof reason.message !== "string") continue;
    reasons.push({
      code: reason.code,
      severity: typeof reason.severity === "string" ? reason.severity : "info",
      message: reason.message,
    });
  }
  return {
    verdict: body.verdict,
    complete: body.complete,
    reasons,
    providers: {
      goplus: providers.goplus as string,
      honeypot: providers.honeypot as string,
      scamSniffer: providers.scamSniffer as string,
      registry: providers.registry as string,
    },
    explanation: body.explanation,
  };
}

function parseReportResult(value: unknown): ReportResult {
  if (!value || typeof value !== "object") throw new Error("The registry response was not in the expected shape.");
  const body = value as Record<string, unknown>;
  const reasons = body.reasons;
  if (typeof body.address !== "string" || typeof body.configured !== "boolean" || typeof body.reportCount !== "string") {
    throw new Error("The registry response was not in the expected shape.");
  }
  if (!reasons || typeof reasons !== "object") throw new Error("The registry response was not in the expected shape.");
  const counts = reasons as Record<string, unknown>;
  for (const key of ["drainer", "honeypot", "phishing", "mintOrRug", "other"] as const) {
    if (typeof counts[key] !== "string") throw new Error("The registry response was not in the expected shape.");
  }
  return {
    address: body.address,
    chainId: chainField(body.chainId),
    configured: body.configured,
    reportCount: body.reportCount,
    reasons: {
      drainer: counts.drainer as string,
      honeypot: counts.honeypot as string,
      phishing: counts.phishing as string,
      mintOrRug: counts.mintOrRug as string,
      other: counts.other as string,
    },
    ...(typeof body.message === "string" ? { message: body.message } : {}),
  };
}

function chainField(value: unknown): ChainId {
  if (value === 56 || value === 97 || value === 8453) return value;
  throw new Error("chainId must be 56, 97, or 8453.");
}

function addressField(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} must be a 20-byte hex address.`);
  }
  const address = value.toLowerCase();
  if (/^0x0{40}$/.test(address)) throw new Error(`${name} is the zero address.`);
  return address;
}

function dataField(value: unknown): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error("data must be even-length hex.");
  }
  return value.toLowerCase();
}

function valueField(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("value is out of range.");
    return String(value);
  }
  if (typeof value === "string" && (/^\d+$/.test(value) || /^0x[0-9a-fA-F]+$/.test(value))) return value;
  throw new Error("value must be a decimal or hex amount.");
}

async function readJson(response: Response, fallback: string): Promise<unknown> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(fallback);
  }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error: unknown }).error)
      : fallback;
    throw new Error(message);
  }
  return payload;
}
