import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_API_URL } from "../src/api.js";
import { createServer } from "../src/server.js";

const FROM = "0x0000000000000000000000000000000000000001";
const TO = "0x0000000000000000000000000000000000000002";

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

async function connect(fetchImpl: typeof fetch) {
  const client = new Client({ name: "custos-test", version: "0.0.0" });
  const server = createServer({ fetch: fetchImpl, baseUrl: PRODUCTION_API_URL });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stdio tools", () => {
  it("lists custos_check and custos_report", async () => {
    const session = await connect(vi.fn());
    try {
      const listed = await session.client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["custos_check", "custos_report"]);
    } finally {
      await session.close();
    }
  });

  it("returns the check verdict through the MCP client", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      verdict: "danger",
      score: 30,
      complete: true,
      providers: { goplus: "answered", honeypot: "answered", scamSniffer: "answered", registry: "skipped" },
      reasons: [{ code: "honeypot", severity: "danger", message: "Token looks like a honeypot." }],
      simulation: { mode: "simulate", success: true, revertReason: null, assetChanges: [], approvals: [] },
      explanation: "Verdict: danger. Token looks like a honeypot.",
      checkedAt: "2026-11-26T00:00:00.000Z",
    }));
    const session = await connect(fetchMock);
    try {
      const result = await session.client.callTool({
        name: "custos_check",
        arguments: { chainId: 8453, from: FROM, to: TO, data: "0x", value: "0" },
      }) as ToolResult;
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        verdict: "danger",
        complete: true,
        providers: { honeypot: "answered" },
      });
      expect(result.structuredContent?.reasons).toEqual([
        { code: "honeypot", severity: "danger", message: "Token looks like a honeypot." },
      ]);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      await session.close();
    }
  });

  it("does not forward a private key", async () => {
    const fetchMock = vi.fn();
    const session = await connect(fetchMock);
    try {
      const result = await session.client.callTool({
        name: "custos_check",
        arguments: { chainId: 56, from: FROM, to: TO, data: "0x", value: "0", privateKey: "0xsecret-seed" },
      }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("0xsecret-seed");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it("looks up a registry report", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(`${PRODUCTION_API_URL}/report/${TO}?chainId=56`);
      return Response.json({
        address: TO,
        chainId: 56,
        configured: false,
        reportCount: "0",
        reasons: { drainer: "0", honeypot: "0", phishing: "0", mintOrRug: "0", other: "0" },
        message: "Custos registry is not deployed on this chain yet.",
      });
    });
    const session = await connect(fetchMock as typeof fetch);
    try {
      const result = await session.client.callTool({
        name: "custos_report",
        arguments: { address: TO, chainId: 56 },
      }) as ToolResult;
      expect(result.structuredContent).toMatchObject({
        chainId: 56,
        configured: false,
        reportCount: "0",
      });
    } finally {
      await session.close();
    }
  });
});
