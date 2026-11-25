# Custos

Custos is a pre-sign security check for AI agents. The agent reviews a transaction before the user signs it. These contracts record that opt-in and let Agent ID holders file or withdraw a community report. They do not execute the reviewed transaction, move tokens, or sit in the signature path.

Agent ID is the verified soulbound ERC-721 on BSC mainnet (chain ID 56) at `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`. A wallet holds it when `IERC721(agentId).balanceOf(addr) > 0`. There is no official testnet deployment. Tests and the chain 97 script use `MockAgentID`.

The Foundry project lives in `contracts/`. Solidity `^0.8.24`. Dependencies are `forge-std` and OpenZeppelin, installed locally and not committed.

## Contracts

### CustosHub

Opt-in log for one wallet.

| Function | What it does |
| --- | --- |
| `constructor(address agentId)` | Stores the Agent ID token. Immutable. Reverts if it is the zero address. |
| `activate()` | Caller must hold Agent ID. Marks the wallet protected and emits `Activated(address indexed wallet, uint256 timestamp)`. |
| `logCheck(bytes32 txHash, uint8 verdict)` | Protected wallets only. `0` green, `1` orange, `2` red. Reverts if `verdict > 2`. Emits `CheckLogged(address indexed wallet, bytes32 indexed txHash, uint8 verdict)` and increments that wallet's counter. |
| `isProtected(address) → bool` | Whether the wallet has activated. |
| `checkCount(address) → uint256` | How many checks that wallet has logged. |
| `activatedCount() → uint256` | How many distinct wallets have activated. |
| `agentId() → address` | The token set at construction. |

`activate` is idempotent. A second call from a wallet that is already protected returns without a new event and without changing `activatedCount`.

`logCheck` stores a counter only. The verdict and the hash live in the event, not in storage. Protection is a latch: `logCheck` does not re-read Agent ID. The same hash may be logged more than once; the contract does not deduplicate it.

### CustosRegistry

Community reports against contract addresses. Wallets are raw addresses. There is no name lookup.

| Function | What it does |
| --- | --- |
| `constructor(address agentId)` | Stores the Agent ID token. Immutable. Reverts if it is the zero address. |
| `report(address target, uint8 reason)` | Agent ID holders only. One active report per reporter per target. |
| `retract(address target)` | The original reporter withdraws their active report. Counts go back down. |
| `reportCount(address) → uint256` | Active reports on a target. |
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

Anything outside `1..5` reverts. The zero address as a target reverts. A second active report from the same reporter on the same target reverts with `AlreadyReported`. Retract, then report again, to change the reason. `retract` does not check Agent ID; only the reporter who filed the active report can withdraw it.

`Reported(address indexed target, address indexed reporter, uint8 reason)` and `Retracted(address indexed target, address indexed reporter, uint8 reason)` are the log.

### MockAgentID

`mint(address)` increases `balanceOf`. It is open, it is not soulbound, and it is not Agent ID. The chain 97 script deploys it so the hub and registry have a token to read. Do not deploy it on mainnet, and do not point a mainnet hub or registry at it.

## Admin powers: none

Neither contract has an owner, admin, pauser, upgrader, or proxy. No function is payable. No function transfers a token, sets an approval, or pulls a signature. The Agent ID address cannot be changed after deployment. Nobody can deactivate a wallet, delete another reporter's row, or rewrite a logged verdict. There is no role that can pause `report` or `activate`.

## Safety

- Custos never asks for a private key, a seed phrase, or a keystore password.
- Custos never broadcasts a transaction for a user and never skips a wallet confirmation.
- Custos never requests a token approval, a permit, or an off-chain signature.
- A report is a statement by a holder. It is not a proof that a contract is safe or unsafe.
- `logCheck` does not simulate or submit `txHash`.
- Put RPC URLs and an explorer key in `contracts/.env`. Leave `PRIVATE_KEY` empty and sign with a Foundry keystore. Do not commit `.env`.

## Build and test

```bash
cd contracts
forge install foundry-rs/forge-std@v1.17.0 OpenZeppelin/openzeppelin-contracts@v5.7.0 --no-git
forge build
forge test
forge test --gas-report
```

Compiler: solc `0.8.28`, optimizer `200` runs, EVM `cancun`. `foundry.toml` reads `BSC_RPC_URL`, `BSC_TESTNET_RPC_URL`, and `ETHERSCAN_API_KEY` from the environment. Forge loads `contracts/.env`.

Call gas below is from `forge test -vvvv` against `MockAgentID`. It includes that token's `balanceOf`. The real Agent ID token can move the number by the difference in that read.

| Call | Gas |
| --- | --- |
| `activate`, first time | 72,612 |
| `activate`, already protected | 21,107 to 28,778 |
| `report`, new active report | 96,372 |

## Deploy

The script does not contain a key. Forge takes the signer from `--account <keystore>` or from `--private-key "$PRIVATE_KEY"` at runtime.

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
  --chain bsc_testnet

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

To broadcast with an environment variable instead of a keystore:

```bash
forge script script/DeployMainnet.s.sol --rpc-url bsc --private-key "$PRIVATE_KEY" --broadcast
```

Keep that variable in a shell you control. Do not write it into a file in this repo.

## Verify

`contracts/foundry.toml` points chain 56 and chain 97 at Etherscan API V2 (`https://api.etherscan.io/v2/api?chainid=56` and `chainid=97`). `--chain bsc` or `--chain bsc_testnet` selects that entry. `ETHERSCAN_API_KEY` is an Etherscan key.

Chain 56, after you have the deployed addresses:

```bash
cd contracts
ARGS=$(cast abi-encode "constructor(address)" 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F)

forge verify-contract --chain bsc --watch \
  "$HUB" src/CustosHub.sol:CustosHub --constructor-args "$ARGS"

forge verify-contract --chain bsc --watch \
  "$REGISTRY" src/CustosRegistry.sol:CustosRegistry --constructor-args "$ARGS"
```

Chain 97 uses the deployed `MockAgentID` address as the constructor argument and `--chain bsc_testnet`. Verify the mock with no constructor arguments:

```bash
forge verify-contract --chain bsc_testnet --watch \
  "$MOCK" src/MockAgentID.sol:MockAgentID
```
