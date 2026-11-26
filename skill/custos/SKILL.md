---
name: custos
description: >-
  Before signing or sending any transaction on BNB Smart Chain (chain 56),
  BSC testnet (chain 97), or Base (chain 8453), POST it to the Custos /check
  API and obey the verdict. Use when an agent is about to sign, broadcast,
  approve, swap, transfer, permit, or otherwise submit a transaction on those chains.
---

# Custos pre-sign check

Custos reviews a transaction before anyone signs it. It never signs, never broadcasts, and never asks for a private key, seed phrase, or keystore. Do not ask the owner for those, and do not put them in the request. An `allow` result only means you may hand the transaction to the owner's wallet. The wallet still has to confirm it.

## When to check

Check before you sign or send any transaction on:

- BNB Smart Chain, chain id `56`
- BSC testnet, chain id `97`
- Base, chain id `8453`

If the chain is not one of those three, this skill does not apply. Do not invent another Custos URL.

## Request

`POST https://api.custosprotocol.com/check`

`Content-Type: application/json`

Body, and only these fields:

```json
{
  "chainId": 56,
  "from": "0x0000000000000000000000000000000000000001",
  "to": "0x0000000000000000000000000000000000000002",
  "data": "0x",
  "value": "0"
}
```

- `chainId` is the number `56`, `97`, or `8453`.
- `from` and `to` are 20-byte hex addresses. The zero address is rejected.
- `data` is even-length hex, including `0x` when the calldata is empty.
- `value` is a decimal string, a hex string, or a safe integer. It is the native amount in wei.
- Unknown JSON fields are rejected. Do not send `privateKey`, `private_key`, `seed`, `mnemonic`, `secret`, or `seed_phrase`.

Read `verdict`, `complete`, `reasons`, and `providers` from the JSON response. `verdict` is `safe`, `warn`, or `danger`. `complete` is a boolean. `reasons` is a list of `{ code, severity, message }`. `providers` says whether `goplus`, `honeypot`, `scamSniffer`, and `registry` answered (`answered`, `failed`, `skipped`, or `unconfigured` for the registry).

## What to do with the verdict

Map the response to one action. Do this after every check, including a retry.

| Result | Action |
| --- | --- |
| The request fails, or the body has no `verdict` | Do not sign. Tell the owner the check did not finish. |
| `complete` is `false` | **Warn.** Stop and ask the owner to confirm. Do not sign yet. |
| `verdict` is `danger` | **Block.** Do not sign. Tell the owner the reasons. |
| `verdict` is `warn` | **Warn.** Stop and ask the owner to confirm. Do not sign yet. |
| `verdict` is `safe` and `complete` is `true` | **Allow.** You may hand the transaction to the owner's wallet. The wallet still confirms it. |
| Any other `verdict` | **Warn.** Stop and ask the owner to confirm. |

`complete: false` is warn even when `verdict` is `safe`. The API already keeps an incomplete check off `safe`, but still treat `complete: false` as warn if you see it.

A `provider_failed` reason only means that provider did not answer. It does not mean the check is incomplete. Honeypot.is can cover a token when GoPlus is rate limited, and the response can be `complete: true`. Obey `complete` and `verdict`, not the wording of a single provider miss. The explanation says `This check is incomplete.` only when `complete` is false.

On warn, show the owner the reasons and wait for a clear yes before the wallet confirmation. On block, do not ask them to sign it anyway. On allow, do not skip the wallet confirmation and do not broadcast the transaction yourself.

## curl

```bash
curl -s -X POST https://api.custosprotocol.com/check \
  -H 'content-type: application/json' \
  -d '{"chainId":97,"from":"0x0000000000000000000000000000000000000001","to":"0x0000000000000000000000000000000000000002","data":"0x","value":"0"}'
```

## fetch

```ts
const response = await fetch("https://api.custosprotocol.com/check", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    chainId: 56,
    from: "0x0000000000000000000000000000000000000001",
    to: "0x0000000000000000000000000000000000000002",
    data: "0x",
    value: "0",
  }),
});
const result = await response.json();
if (!response.ok || typeof result.verdict !== "string" || typeof result.complete !== "boolean") {
  throw new Error("Custos check did not finish.");
}
const action = result.complete === false || result.verdict === "warn"
  ? "warn"
  : result.verdict === "danger"
    ? "block"
    : result.verdict === "safe"
      ? "allow"
      : "warn";
```

`block`: do not sign, and tell the owner. `warn`: stop and ask the owner to confirm. `allow`: proceed to the owner's wallet confirmation.

## Helper

From this skill folder:

```bash
node scripts/check.mjs --chain 56 --from 0x0000000000000000000000000000000000000001 --to 0x0000000000000000000000000000000000000002 --data 0x --value 0
```

The script prints `{ action, verdict, complete, reasons, providers }`. Exit `0` is allow, `2` is warn, `3` is block, and `1` is a failed check. A failed check means do not sign. `CUSTOS_API_URL` overrides the API base. The default is `https://api.custosprotocol.com`.

## Registry lookup

`GET https://api.custosprotocol.com/report/<address>?chainId=56` returns community report counts. `chainId` may be `56`, `97`, or `8453` and defaults to `97`. Base has no Custos registry. A report is a statement by an Agent ID holder. It is not proof that an address is safe or unsafe. This lookup is not a substitute for `/check`.
