import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { checkTransaction, lookupReport, type RequestOptions } from "./api.js";

const chainId = z.union([z.literal(56), z.literal(97), z.literal(8453)]);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address");

const checkInput = z.object({
  chainId: chainId.describe("56 BSC, 97 BSC testnet, or 8453 Base."),
  from: address.describe("Simulated sender. Not a private key."),
  to: address.describe("Transaction target."),
  data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/, "even-length hex").describe("Calldata, or 0x when empty."),
  value: z.union([
    z.string().regex(/^(?:0x[0-9a-fA-F]+|\d+)$/, "decimal or hex amount"),
    z.number().int().nonnegative(),
  ]).describe("Native value in wei, as a decimal string, hex string, or safe integer."),
}).strict();

const reportInput = z.object({
  address: address.describe("Address to look up in the Custos registry."),
  chainId: chainId.optional().describe("56, 97, or 8453. Defaults to 97, matching the API."),
}).strict();

const checkOutput = z.object({
  verdict: z.string(),
  complete: z.boolean(),
  reasons: z.array(z.object({
    code: z.string(),
    severity: z.string(),
    message: z.string(),
  })),
  providers: z.object({
    goplus: z.string(),
    honeypot: z.string(),
    scamSniffer: z.string(),
    registry: z.string(),
  }),
  explanation: z.string(),
}).strict();

const reportOutput = z.object({
  address: z.string(),
  chainId: chainId,
  configured: z.boolean(),
  reportCount: z.string(),
  reasons: z.object({
    drainer: z.string(),
    honeypot: z.string(),
    phishing: z.string(),
    mintOrRug: z.string(),
    other: z.string(),
  }),
  message: z.string().optional(),
}).strict();

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function createServer(options: RequestOptions = {}): McpServer {
  const server = new McpServer({ name: "custos-mcp", version: "0.1.0" });

  server.registerTool(
    "custos_check",
    {
      title: "Check a transaction",
      description:
        "Check a transaction before it is signed on BNB Smart Chain (56), BSC testnet (97), or Base (8453). " +
        "Send only chainId, from, to, data, and value. Do not send a private key, seed phrase, or keystore. " +
        "Custos does not sign or broadcast. Returns verdict, complete, reasons, providers, and explanation. " +
        "danger: do not sign, and tell the owner. warn, or complete false: stop and ask the owner to confirm. " +
        "safe with complete true: the owner may confirm it in their own wallet. Do not skip that confirmation. " +
        "A provider_failed reason does not by itself mean the check is incomplete. " +
        "If this tool errors, do not sign.",
      inputSchema: checkInput,
      outputSchema: checkOutput,
      annotations: READ_ONLY,
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await checkTransaction(args, options);
        return jsonResult(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "custos_report",
    {
      title: "Look up community reports",
      description:
        "Read Custos community-report counts for an address from GET /report/:address. " +
        "chainId is 56, 97, or 8453 and defaults to 97. Base has no registry. " +
        "A report is a statement by an Agent ID holder, not proof that an address is safe or unsafe. " +
        "This does not send a transaction and is not a substitute for custos_check.",
      inputSchema: reportInput,
      outputSchema: reportOutput,
      annotations: READ_ONLY,
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await lookupReport(args.address, args.chainId ?? 97, options);
        return jsonResult(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  return server;
}

function jsonResult(value: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function toolError(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : "Check failed.";
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
