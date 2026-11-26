# custosprotocol-mcp

MCP server for the [Custos](https://custosprotocol.com) pre-sign check. It speaks stdio and calls the live API at `https://api.custosprotocol.com`.

`custos_check` posts `{ chainId, from, to, data, value }` to `POST /check` and returns `verdict`, `complete`, `reasons`, `providers`, and `explanation`. `chainId` is `56` (BNB Smart Chain), `97` (BSC testnet), or `8453` (Base).

`custos_report` reads `GET /report/<address>?chainId=`. `chainId` defaults to `97`. Base has no registry.

Custos does not sign, broadcast, or accept a private key, seed phrase, or keystore. Do not put those in a tool call. Never use QR login or WalletConnect. Never transfer funds on your own initiative. A `safe` verdict with `complete: true` still has to be confirmed in the owner's wallet.

| Result | What the agent should do |
| --- | --- |
| `verdict` `danger` | Do not sign. Tell the owner. Danger blocks even when complete is false. |
| `verdict` `warn`, or `complete: false` | Stop and ask the owner to confirm. This does not apply when `verdict` is `danger`. |
| `verdict` `safe` and `complete: true` | Hand the transaction to the owner's wallet. The wallet still confirms it. |
| Tool error | Do not sign. |

A `provider_failed` reason means that provider did not answer. It does not mean the check is incomplete. Only `complete: false` does.

`CUSTOS_API_URL` overrides the API base. Leave it unset to use `https://api.custosprotocol.com`.

This package is `custosprotocol-mcp`. It is not published from this repository snapshot. After publication, clients start it with `npx -y custosprotocol-mcp`. Until then, build it and point the client at `node`:

```bash
cd mcp
npm install
npm test
npm run typecheck
npm run build
node dist/index.js
```

## Claude Desktop

`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Linux: `~/.config/Claude/`):

```json
{
  "mcpServers": {
    "custos": {
      "command": "npx",
      "args": ["-y", "custosprotocol-mcp"]
    }
  }
}
```

## Claude Code

`.mcp.json` in the project, or the user config:

```json
{
  "mcpServers": {
    "custos": {
      "command": "npx",
      "args": ["-y", "custosprotocol-mcp"]
    }
  }
}
```

## Cursor

`.cursor/mcp.json` in the project, or Cursor Settings → MCP:

```json
{
  "mcpServers": {
    "custos": {
      "command": "npx",
      "args": ["-y", "custosprotocol-mcp"]
    }
  }
}
```

## Any MCP client

Launch the stdio server with `npx -y custosprotocol-mcp`. A local build uses `node` and the `dist/index.js` path instead of `npx`. Optional environment:

```json
{
  "mcpServers": {
    "custos": {
      "command": "npx",
      "args": ["-y", "custosprotocol-mcp"],
      "env": {
        "CUSTOS_API_URL": "https://api.custosprotocol.com"
      }
    }
  }
}
```
