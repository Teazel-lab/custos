import { API_BASE } from './config'

const FROM = '0x0000000000000000000000000000000000000001'
const TO = '0x0000000000000000000000000000000000000002'

export const CHECK_CURL = `curl -s -X POST ${API_BASE}/check \\
  -H 'content-type: application/json' \\
  -d '{"chainId":97,"from":"${FROM}","to":"${TO}","data":"0x","value":"0"}'`

export const CHECK_FETCH = `const response = await fetch("${API_BASE}/check", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    chainId: 56,
    from: "${FROM}",
    to: "${TO}",
    data: "0x",
    value: "0",
  }),
});
const result = await response.json();
if (!response.ok || typeof result.verdict !== "string" || typeof result.complete !== "boolean") {
  throw new Error("Custos check did not finish.");
}
const action = result.verdict === "danger"
  ? "block"
  : result.verdict === "warn" || result.complete === false
    ? "warn"
    : result.verdict === "safe" && result.complete === true
      ? "allow"
      : "warn";`

export const CHECK_CARD = `await fetch("${API_BASE}/check", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ chainId, from, to, data, value }),
})`

export const SKILL_INSTALL = `Copy the skill/custos folder into the agent's skills directory.

Cursor (project): .cursor/skills/custos
Cursor (home): ~/.cursor/skills/custos
Claude Code: .claude/skills/custos

The folder contains SKILL.md. From that folder:

node scripts/check.mjs --chain 56 --from ${FROM} --to ${TO} --data 0x --value 0

The script prints action allow, warn, or block. It does not ask for a key, and it does not sign.`

const MCP_SERVER = `{
  "mcpServers": {
    "custos": {
      "command": "npx",
      "args": ["-y", "custosprotocol-mcp"]
    }
  }
}`

export const MCP_CLAUDE_DESKTOP = MCP_SERVER
export const MCP_CLAUDE_CODE = MCP_SERVER
export const MCP_CURSOR = MCP_SERVER

export const MCP_REMOTE_URL = `${API_BASE}/mcp`

export const MCP_INIT_CURL = `curl -s -X POST ${API_BASE}/mcp \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'`

export const MCP_GENERIC = `{
  "mcpServers": {
    "custos": {
      "command": "npx",
      "args": ["-y", "custosprotocol-mcp"],
      "env": {
        "CUSTOS_API_URL": "${API_BASE}"
      }
    }
  }
}`

export const VERDICT_RULES = [
  {
    id: 'block',
    title: 'Block',
    text: 'verdict danger. Danger blocks even when complete is false. Do not sign. Tell the owner the reasons. Do not ask them to sign it anyway.',
  },
  {
    id: 'warn',
    title: 'Warn',
    text: 'verdict warn, or complete false, unless the verdict is danger. Stop and ask the owner to confirm before anything is signed.',
  },
  {
    id: 'allow',
    title: 'Allow',
    text: 'verdict safe and complete true. Hand the transaction to the owner\'s wallet. The wallet still confirms it. Custos does not sign or broadcast.',
  },
] as const
