import { afterEach, describe, expect, it, vi } from "vitest";
import { apiBase, checkTransaction, lookupReport, PRODUCTION_API_URL } from "../src/api.js";

const FROM = "0x0000000000000000000000000000000000000001";
const TO = "0x0000000000000000000000000000000000000002";

const CHECK = {
  verdict: "warn",
  score: 70,
  complete: true,
  providers: { goplus: "failed", honeypot: "answered", scamSniffer: "answered", registry: "unconfigured" },
  reasons: [{
    code: "provider_failed",
    severity: "info",
    message: "GoPlus did not answer (rate limited); other providers were used where possible.",
  }],
  simulation: { mode: "simulate", success: true, revertReason: null, assetChanges: [], approvals: [] },
  explanation: "Verdict: warn. GoPlus did not answer (rate limited); other providers were used where possible.",
  checkedAt: "2026-11-26T00:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CUSTOS_API_URL;
});

describe("api base", () => {
  it("defaults to the production API", () => {
    expect(apiBase({})).toBe(PRODUCTION_API_URL);
    expect(PRODUCTION_API_URL).toBe("https://api.custosprotocol.com");
  });

  it("uses CUSTOS_API_URL when it is set", () => {
    expect(apiBase({ CUSTOS_API_URL: "http://localhost:8787/" })).toBe("http://localhost:8787");
  });
});

describe("custos_check", () => {
  it("posts the five fields and returns verdict, complete, reasons, and providers", async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => Response.json(CHECK));
    const result = await checkTransaction(
      { chainId: 56, from: FROM, to: TO, data: "0x", value: "0" },
      { fetch: fetchMock, baseUrl: "https://api.custosprotocol.com" },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.custosprotocol.com/check");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ chainId: 56, from: FROM, to: TO, data: "0x", value: "0" });
    expect(result).toEqual({
      verdict: "warn",
      complete: true,
      reasons: CHECK.reasons,
      providers: CHECK.providers,
      explanation: CHECK.explanation,
    });
    expect(result.explanation).not.toMatch(/incomplete/i);
  });

  it("treats a covered provider miss as data, not as a failed tool call", async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => Response.json({ ...CHECK, verdict: "safe", complete: true }));
    const result = await checkTransaction(
      { chainId: 8453, from: FROM, to: TO, data: "0x", value: 0 },
      { fetch: fetchMock, baseUrl: PRODUCTION_API_URL },
    );
    const sent = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(sent?.body)).value).toBe("0");
    expect(result.verdict).toBe("safe");
    expect(result.complete).toBe(true);
    expect(result.providers.honeypot).toBe("answered");
  });

  it("refuses a key or seed and does not call the API", async () => {
    const fetchMock = vi.fn();
    await expect(checkTransaction(
      { chainId: 56, from: FROM, to: TO, data: "0x", value: "0", privateKey: "0xsecret" },
      { fetch: fetchMock, baseUrl: PRODUCTION_API_URL },
    )).rejects.toThrow(/does not accept a key or a seed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces an API error", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: "chainId must be 56, 97, or 8453." }, { status: 400 }));
    await expect(checkTransaction(
      { chainId: 56, from: FROM, to: TO, data: "0x", value: "0" },
      { fetch: fetchMock, baseUrl: PRODUCTION_API_URL },
    )).rejects.toThrow(/chainId must be 56, 97, or 8453/);
  });
});

describe("custos_report", () => {
  it("reads registry counts for the requested chain", async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => Response.json({
      address: TO,
      chainId: 97,
      configured: true,
      reportCount: "2",
      reasons: { drainer: "1", honeypot: "1", phishing: "0", mintOrRug: "0", other: "0" },
    }));
    const result = await lookupReport(TO, 97, { fetch: fetchMock, baseUrl: PRODUCTION_API_URL });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${PRODUCTION_API_URL}/report/${TO}?chainId=97`);
    expect(result.reportCount).toBe("2");
    expect(result.reasons.honeypot).toBe("1");
  });

  it("keeps the Base message when the registry is absent", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      address: TO,
      chainId: 8453,
      configured: false,
      reportCount: "0",
      reasons: { drainer: "0", honeypot: "0", phishing: "0", mintOrRug: "0", other: "0" },
      message: "The Custos registry is on BNB Chain. Base has no registry.",
    }));
    const result = await lookupReport(TO, 8453, { fetch: fetchMock, baseUrl: PRODUCTION_API_URL });
    expect(result.configured).toBe(false);
    expect(result.message).toMatch(/Base has no registry/);
  });
});
