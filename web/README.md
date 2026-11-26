# Custos website

Static site for [custosprotocol.com](https://custosprotocol.com). It talks to the live check API in the browser and asks the connected wallet to confirm `activate` or `report`. It has no backend and no keys.

Pages:

- `/` — hero, how a check works, use cases, a curl example, contract links
- `/docs` — skill install, MCP config, curl and fetch, verdict rules
- `/activate` — Agents: connect an injected wallet, read Agent ID, read `isProtected`, call `CustosHub.activate`
- `/scanner` — Check: `POST /check` and `GET /report/<address>`
- `/report` — Agent ID holders call `CustosRegistry.report`

Wallet access is the browser extension already installed (MetaMask, Binance Wallet, or any other EIP-6963 / `window.ethereum` provider). There is no QR-code login and no seed phrase field. A transaction is sent only after the matching button click, and the wallet still has to confirm it.

Addresses live in `src/config.ts`. Testnet hub, registry, and MockAgentID are filled in. Mainnet hub and registry are `null`, and those actions show “coming soon” until the two fields are set.

## Run

```bash
cd web
npm install
npm test
npm run typecheck
npm run dev
```

Dev server: `http://localhost:5173`. The API allows that origin.

`npm run build` typechecks and writes `dist/`.

## Deploy

Do not put secrets in this app. Nothing here is secret.

Cloudflare Workers static assets, from `web/` after `npm run build`:

```bash
npx wrangler deploy
```

`wrangler.jsonc` serves `dist/` and falls unknown paths back to `index.html`, so `/activate` and the other routes keep working on refresh. `public/_headers` sets a content security policy, `nosniff`, and `frame-ancestors: none`. Fonts and the hero image are bundled with the site. Plus Jakarta Sans comes from `@fontsource`. The owl is `src/assets/owl-hero.webp` with a JPEG fallback.

Cloudflare Pages, same build output:

```bash
npx wrangler pages deploy dist --project-name custos-web
```

Pages serves the SPA fallback when the project has no `404.html`. Workers uses `not_found_handling`.

Point `custosprotocol.com` and `www.custosprotocol.com` at that deployment. The API already allows both origins.

## Mainnet still open

`CHAINS[56].hub` and `CHAINS[56].registry` are empty on purpose. BSC activation and reports stay disabled until those addresses exist. Agent ID reads on mainnet already use `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F` (`balanceOf`, `handleOf`).
