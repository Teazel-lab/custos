# Custos

Custos is a pre-sign security check for AI agents. The agent reviews a transaction before the user signs it. These contracts record that opt-in and let Agent ID holders file or withdraw a community report. They do not execute the reviewed transaction, move tokens, or sit in the signature path.

Agent ID is the verified soulbound ERC-721 on BSC mainnet (chain ID 56) at `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`. A wallet holds it when `balanceOf(addr) > 0`. Custos reads that through a one-function `IBalanceOf` interface. There is no official testnet deployment. Tests and the chain 97 script use `MockAgentID`, which is test-only and lives under `contracts/script/mocks/`.

The Foundry project lives in `contracts/`. Solidity `^0.8.24`. The dependency is `forge-std`, installed locally and not committed.

## Contracts

### CustosHub

Opt-in log for one wallet.

| Function | What it does |
| --- | --- |
| `constructor(address agentId)` | Stores the Agent ID token. Immutable. Reverts if it is the zero address or has no code. |
| `activate()` | The first call requires Agent ID. Marks the wallet protected and emits `Activated(address indexed wallet, uint256 timestamp)`. |
| `logCheck(bytes32 txHash, uint8 verdict)` | Protected wallets only. `0` green, `1` orange, `2` red. Reverts if `verdict > 2`. Emits `CheckLogged(address indexed wallet, bytes32 indexed txHash, uint8 verdict, uint256 timestamp)` and increments that wallet's counter. |
| `isProtected(address) → bool` | True after the wallet activated while holding Agent ID. It stays true if the wallet later loses the token. |
| `checkCount(address) → uint256` | How many checks that wallet logged. A self-reported signal, not a trust score. |
| `activatedCount() → uint256` | How many distinct wallets have activated. |
| `agentId() → address` | The token set at construction. |

The first `activate` requires the caller to hold Agent ID. A later call from a wallet that is already protected returns immediately, without reading Agent ID, without a new event, and without changing `activatedCount`.

`logCheck` stores a counter only. The verdict and the hash live in the event, not in storage. Protection is a latch: `logCheck` does not re-read Agent ID. The same hash may be logged more than once; the contract does not deduplicate it.

### CustosRegistry

Community reports against addresses (contracts or EOAs). Wallets are raw addresses. There is no name lookup.

| Function | What it does |
| --- | --- |
| `constructor(address agentId)` | Stores the Agent ID token. Immutable. Reverts if it is the zero address or has no code. |
| `report(address target, uint8 reason)` | Agent ID holders only. One active report per reporter per target. |
| `retract(address target)` | The original reporter withdraws their active report. Counts go back down. |
| `reportCount(address) → uint256` | Active reports on a target. A self-reported signal, not a trust score. |
| `reasonsOf(address) → uint256[5]` | Per-reason counts. Index `0` is reason `1`, index `4` is reason `5`. |
| `hasReported(address reporter, address target) → bool` | Whether that reporter has an active report on the target. |
| `reportOf(address reporter, address target) → (uint8 reason, bool active)` | The report row. `reason` is `0` when it is not active. |
| `agentId() → address` | The token set at construction. |

Reason codes:

| Code | Meaning |
| --- | --- |
| 1 | Drainer |
| 2 | Honeypot |
| 3 | Phishing approval or permit |
| 4 | Owner can mint or rug |
| 5 | Other |

Anything outside `1..5` reverts. The zero address as a target reverts. A second active report from the same reporter on the same target reverts with `AlreadyReported`. Retract, then report again, to change the reason. `retract` does not check Agent ID; only the reporter who filed the active report can withdraw it. A report from a wallet that later loses Agent ID stays counted until that reporter retracts it.

`Reported(address indexed target, address indexed reporter, uint8 reason)` and `Retracted(address indexed target, address indexed reporter, uint8 reason)` are the log.

### MockAgentID

Test-only. `mint(address)` increases `balanceOf`. It is open, it is not soulbound, and it is not Agent ID. The chain 97 script deploys it so the hub and registry have a token to read. Do not deploy it on mainnet, and do not point a mainnet hub or registry at it.

## Admin powers: none

Neither contract has an owner, admin, pauser, upgrader, or proxy. No function is payable. No function transfers a token, sets an approval, or pulls a signature. The Agent ID address cannot be changed after deployment. Nobody can deactivate a wallet, delete another reporter's row, or rewrite a logged verdict. There is no role that can pause `report` or `activate`. The Agent ID registry's own owner can admin-register holders; that is inherited trust in the token, not a power of these contracts. If that token's owner pauses or changes it, new `activate` and `report` calls revert. `logCheck` and `retract` keep working.

## Safety

- Custos never asks for a private key, a seed phrase, or a keystore password.
- Custos never broadcasts a transaction for a user and never skips a wallet confirmation.
- Custos never requests a token approval, a permit, or an off-chain signature.
- A report is a statement by a holder. It is not a proof that a contract is safe or unsafe.
- `logCheck` does not simulate or submit `txHash`.
- Put RPC URLs and an explorer key in `contracts/.env`. Sign broadcasts with a Foundry keystore (`--account`). Do not commit `.env`.

## Build and test

```bash
cd contracts
forge install foundry-rs/forge-std@v1.17.0 --no-git
forge build
forge test
forge test --gas-report
```

Compiler: solc `0.8.28`, optimizer `200` runs, EVM `cancun`. `foundry.toml` reads `BSC_RPC_URL`, `BSC_TESTNET_RPC_URL`, and `ETHERSCAN_API_KEY` from the environment. Forge loads `contracts/.env`.

Gas below is copied from `forge test --gas-report` (solc 0.8.28, optimizer 200, Cancun) against `MockAgentID`. The figures are every call in the suite, so `activate` min is the already-protected return and max is a first activation. A real Agent ID `balanceOf` can move the calls that read it.

| Function | Min | Avg | Median | Max |
| --- | --- | --- | --- | --- |
| `activate` | 21,107 | 54,135 | 72,612 | 72,612 |
| `report` | 21,615 | 81,236 | 79,260 | 96,372 |

## Deploy

The script does not contain a key. Forge takes the signer from `--account <keystore>`.

```bash
cd contracts
cp .env.example .env
# Fill ETHERSCAN_API_KEY. The sample RPC URLs are public chain 56 and chain 97 endpoints.

cast wallet import custos --interactive

# Chain 97. Deploys MockAgentID, CustosHub, and CustosRegistry.
forge script script/DeployTestnet.s.sol \
  --rpc-url bsc_testnet \
  --account custos \
  --broadcast \
  --verify \
  --chain bsc-testnet

# Chain 56. Deploys CustosHub and CustosRegistry against the Agent ID token above.
forge script script/DeployMainnet.s.sol \
  --rpc-url bsc \
  --account custos \
  --broadcast \
  --verify \
  --chain bsc
```

The deployer wallet needs the native coin of that chain for gas. It does not need to hold Agent ID. Deploying does not activate the deployer.

On chain 97 the mock mint is open. The agent wallet has to mint itself a balance before `activate` or `report` will succeed:

```bash
cast send "$MOCK" "mint(address)" "$AGENT_WALLET" --rpc-url bsc_testnet --account custos
```

On chain 56 the wallet must already hold the soulbound Agent ID token. Custos cannot mint that token.

## Verify

`contracts/foundry.toml` points chain 56 and chain 97 at Etherscan API V2 (`https://api.etherscan.io/v2/api?chainid=56` and `chainid=97`). `--chain bsc` or `--chain bsc-testnet` selects that entry. `ETHERSCAN_API_KEY` is an Etherscan key. Etherscan API V2 verification on BSC may need a paid plan. If that rejects the submission, verify with BscScan or Sourcify (`--verifier sourcify`).

Chain 56, after you have the deployed addresses:

```bash
cd contracts
ARGS=$(cast abi-encode "constructor(address)" 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F)

forge verify-contract --chain bsc --watch \
  "$HUB" src/CustosHub.sol:CustosHub --constructor-args "$ARGS"

forge verify-contract --chain bsc --watch \
  "$REGISTRY" src/CustosRegistry.sol:CustosRegistry --constructor-args "$ARGS"
```

Chain 97 uses the deployed `MockAgentID` address as the constructor argument and `--chain bsc-testnet`. Verify the mock with no constructor arguments:

```bash
forge verify-contract --chain bsc-testnet --watch \
  "$MOCK" script/mocks/MockAgentID.sol:MockAgentID
```

## Check API

`api/` is a Cloudflare Worker. `POST /check` inspects a transaction an agent is about to sign and returns a verdict. It never accepts a key or seed, never signs, and never broadcasts. The caller still confirms the transaction in their own wallet.

The live chain 97 contracts are CustosHub `0x062D0452187094C1B2dd546B6a793A50eBDBfd06`, CustosRegistry `0x14df99CEa96C8f0980cA0aF46CB5d30de782353A`, and MockAgentID `0xBC7e6AF6F97f2A9A56a1784D3E17d31361ed8945`. Chain 56 checks return a `registry_unconfigured` warning until the mainnet registry address is set. The chain 56 slot in the worker stays empty on purpose.

`POST /check` takes `{ "chainId": 56 or 97, "from", "to", "data", "value" }`. `value` is a decimal string, a hex string, or a safe integer. Unknown JSON fields are rejected. The response is `{ verdict, score, complete, reasons, simulation, explanation, checkedAt }`. `complete` is false when GoPlus or ScamSniffer did not answer. `verdict` is `safe`, `warn`, or `danger`. `simulation.mode` is `trace` when `debug_traceCall` succeeded, `simulate` when `eth_simulateV1` succeeded, and `call` when the check used `eth_call` plus `eth_estimateGas`. Trace is the primary path on mainnet: Alchemy Pay As You Go answers `debug_traceCall` with `callTracer` and `withLog` on bnb-mainnet. The check then tries `eth_simulateV1` (`traceTransfers: true`, `validation: false`) on that chain's plain RPC, then `eth_call`. Each chain has its own URL. A chain 97 check never calls the chain 56 endpoint. Call mode adds `trace_unavailable`, and also warns when the selector is not a known decode or when `value` is greater than zero. It is not a clean `safe` result.

`eth_simulateV1` and trace logs become `assetChanges` and `approvals`. A synthetic native transfer is an asset of `native`. Only logs whose owner or sender is `tx.from` feed reputation lookups. Calldata decoding covers approve, increaseAllowance, setApprovalForAll, permit (owner is the first word), transfer, safeTransferFrom, transferFrom, and Permit2. Permit2 amounts are uint160. An amount of at least 2^159 is unlimited (`approve` is `0x87517c45`, single `permit` is `0x2b67b570`, `PermitBatch` is `0x2a2d80d1`). An ERC-20 amount of at least 2^128 is unlimited. `approve(spender, 0)` is not a revoke unless `spender` is the zero address.

`simulation.revertReason` may contain revert text from the chain. That text is untrusted: control characters are stripped and it is capped. Reason messages and the explanation use fixed strings. The optional model sees reason codes and those fixed strings, not revert data.

`GET /health` returns `{ "ok": true }`. `GET /report/:address?chainId=97` returns that address's registry counts. `chainId` defaults to 97. A short registry `eth_call` result is a failed read, not a zero count.

Signals run together under one deadline of about 10 seconds. A provider that times out or errors becomes an info reason (`provider_failed`) and the rest of the check still finishes. When that miss is GoPlus or ScamSniffer, `complete` is false and the verdict is no better than `warn` (the score is then at most 85 if nothing else fired). GoPlus address and token calls wait about 8 seconds. When `GOPLUS_APP_KEY` and `GOPLUS_APP_SECRET` are both set, those calls send a GoPlus access token. The Worker POSTs `app_key`, unix `time`, and `sign` (`sha1` of `app_key`, `time`, and `app_secret` concatenated) to `https://api.gopluslabs.io/api/v1/token`. GoPlus documents `expires_in` as seconds until the token expires, and documents the security-call header as `Authorization: Bearer <access_token>`. The token is stored in KV in the clear under `goplus:auth:` (anyone who can read that namespace can read it) until a minute before `expires_in`, at least 60 seconds, and at most one day. A missing `expires_in` is cached for 5 minutes. The token request itself waits about 3 seconds and is not tied to one check's deadline. HTTP 401 or GoPlus code 4022 (invalid token in the official SDK's error list) refreshes it once. A bare HTTP 403 does not. If `/token` fails for any reason, the security call goes out without a token, and further token fetches are skipped for about 2 minutes (about an hour when GoPlus reports a bad key or signature: codes 4010, 4011, or 4012). The key, secret, and token are never logged or returned. If either secret is missing, GoPlus stays unauthenticated. A failed GoPlus or ScamSniffer call adds a short cause to the `provider_failed` reason, such as `GoPlus HTTP 403` or `GoPlus code 4029`. Workers Logs record the HTTP status, GoPlus code or message, or a timeout or network error, and they do not include the key, secret, or token. Reputation calls send `User-Agent: CustosProtocol/1.0 (+https://api.custosprotocol.com)`. A GoPlus body that contains a record is cached for about an hour. An empty GoPlus body, or a token GoPlus has not indexed, is cached for about 90 seconds. The transaction target, when it is one of those unindexed tokens, adds `unknown_token` (`warn`). A failed GoPlus security response is not written to KV. A `/check` response that contains `provider_failed` is not stored in the 60 second check cache, so the next identical request tries again. Token and address reputation on chain 56 use honeypot.is, GoPlus, and the public ScamSniffer blacklist. GoPlus `address_security` is one address per request. Chain 97 skips honeypot.is and GoPlus and adds `unsupported_on_testnet`. An optional OpenAI-compatible model may rewrite the explanation. It cannot change `verdict`. A reply that says "safe" when the verdict is not safe, or that drops a reason code, falls back to the template. The explanation always says to confirm the transaction in the caller's own wallet.

Results are cached in KV. Cache errors are ignored. The check cache is about 60 seconds, and it skips responses that include `provider_failed`. Code lookups are about 10 minutes, so an EIP-7702 delegation (`0xef0100`) is not treated as a contract for a day. The ScamSniffer list is stored in shards by the first address byte, and a failed download is remembered for about 5 minutes. Requests are limited to 60 per minute by the Workers Rate Limiting binding (`CHECK_LIMIT`). IPv6 clients share a key on the /64 prefix. The API is free and keyless. `authorize()` is the place a later plan check would read `Authorization`.

Browser calls are allowed from `https://custosprotocol.com` and `https://www.custosprotocol.com`. `http://localhost`, `http://127.0.0.1`, and `http://[::1]` (any port) are allowed only when `ALLOW_DEV_ORIGINS=1`. Set that in `.dev.vars` for `wrangler dev`. Leave it unset in production.

### Setup

```bash
cd api
npm install
cp .dev.vars.example .dev.vars
```

Put secrets in `.dev.vars` for local dev, or in production with `wrangler secret put`. Do not commit them.

| Name | Required | Purpose |
| --- | --- | --- |
| `RPC_URL_56` | Recommended | Plain JSON-RPC for chain 56. Alchemy mainnet looks like `https://bnb-mainnet.g.alchemy.com/v2/<key>`. If empty, chain 56 uses `https://bsc.publicnode.com`. |
| `RPC_URL_97` | Recommended | Plain JSON-RPC for chain 97. Alchemy testnet looks like `https://bnb-testnet.g.alchemy.com/v2/<key>`. If empty, chain 97 uses `https://bsc-testnet.publicnode.com`. |
| `TRACE_RPC_URL_56` | Recommended on mainnet | `debug_traceCall` with `callTracer` and `withLog`. Primary path on mainnet. Alchemy Pay As You Go on bnb-mainnet answers it. If this is empty or the call errors, the check uses `eth_simulateV1` on `RPC_URL_56`, then `eth_call`. |
| `TRACE_RPC_URL_97` | No | Same trace call for chain 97. |
| `LLM_API_KEY` | No | Explanation rewrite only. |
| `LLM_BASE_URL`, `LLM_MODEL` | No | Non-secret Worker vars. Defaults are `https://api.openai.com/v1` and `gpt-4o-mini`. |
| `GOPLUS_APP_KEY` | No | GoPlus app key. Used only when `GOPLUS_APP_SECRET` is set as well. |
| `GOPLUS_APP_SECRET` | No | GoPlus app secret. Used only when `GOPLUS_APP_KEY` is set as well. Never logged. |

Create the cache and replace the placeholder id in `api/wrangler.jsonc`:

```bash
npx wrangler kv namespace create CUSTOS_CACHE
```

The binding name is `CACHE`. `wrangler.jsonc` also binds `CHECK_LIMIT`, a Workers rate limiter of 60 requests per 60 seconds (`namespace_id` `1001`). Observability logs stay on. Traces stay off so outbound URLs that contain API keys are not recorded.

```bash
npm test
npm run typecheck
npx wrangler dev
```

`wrangler dev` serves `http://localhost:8787`. This repo does not deploy the Worker.

```bash
curl -s http://localhost:8787/health

curl -s http://localhost:8787/report/0x0000000000000000000000000000000000000002?chainId=97

curl -s -X POST http://localhost:8787/check \
  -H 'content-type: application/json' \
  -d '{"chainId":97,"from":"0x0000000000000000000000000000000000000001","to":"0x0000000000000000000000000000000000000002","data":"0x","value":"0"}'
```

Set `RPC_URL_56` and `RPC_URL_97` separately. A mainnet Alchemy URL will not answer chain 97 reads, and the worker will not send a chain 97 check to it.

## Website

`web/` is the static site for custosprotocol.com. It calls this API from the browser and asks the user's own wallet to confirm `activate` or `report`. It does not take a key. Local dev and Cloudflare deploy steps are in `web/README.md`.
