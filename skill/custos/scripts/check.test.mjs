import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { actionFor } from "./check.mjs";

const FROM = "0x0000000000000000000000000000000000000001";
const TO = "0x0000000000000000000000000000000000000002";
const script = fileURLToPath(new URL("./check.mjs", import.meta.url));

test("danger blocks even when complete is false", () => {
  assert.equal(actionFor({ verdict: "danger", complete: false }), "block");
  assert.equal(actionFor({ verdict: "danger", complete: true }), "block");
  assert.equal(actionFor({ verdict: "warn", complete: false }), "warn");
  assert.equal(actionFor({ verdict: "warn", complete: true }), "warn");
  assert.equal(actionFor({ verdict: "safe", complete: false }), "warn");
  assert.equal(actionFor({ verdict: "safe", complete: true }), "allow");
  assert.equal(actionFor({ verdict: "unknown", complete: true }), "warn");
});

test("check.mjs exits 3 when the API returns danger and complete false", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      verdict: "danger",
      complete: false,
      reasons: [{ code: "honeypot", severity: "danger", message: "Token looks like a honeypot." }],
      providers: { goplus: "failed", honeypot: "answered", scamSniffer: "answered", registry: "skipped" },
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  try {
    const result = await runCheck(port);
    assert.equal(result.code, 3, result.stderr);
    assert.match(result.stdout, /"action": "block"/);
    assert.match(result.stdout, /"complete": false/);
  } finally {
    server.close();
  }
});

function runCheck(port) {
  const child = spawn(process.execPath, [
    script,
    "--chain", "56",
    "--from", FROM,
    "--to", TO,
    "--data", "0x",
    "--value", "0",
  ], {
    env: { ...process.env, CUSTOS_API_URL: `http://127.0.0.1:${port}` },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
