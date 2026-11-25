// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @title CustosHub
/// @notice Opt-in log for an agent that already ran a pre-sign check.
/// @dev No owner, no admin, no proxy, and no payable function. The Agent ID
///      token is fixed at construction. `activate` is idempotent: a wallet
///      that is already protected can call it again and nothing changes.
///      `logCheck` does not store verdicts. It increments a per-wallet counter
///      and emits the verdict. Protection is a latch; `logCheck` does not
///      re-read Agent ID.
contract CustosHub {
    /// @notice Agent ID token. Holder check is `balanceOf(addr) > 0`.
    address public immutable agentId;

    /// @notice Wallets that have successfully called `activate`.
    uint256 public activatedCount;

    mapping(address wallet => bool) private _protected;
    mapping(address wallet => uint256) private _checks;

    /// @notice The caller does not hold Agent ID.
    error NotAgentIdHolder();

    /// @notice `agentId` was the zero address.
    error ZeroAgentId();

    /// @notice The caller has not activated.
    error NotProtected();

    /// @notice Verdict was greater than 2. Valid values are 0, 1, and 2.
    error InvalidVerdict();

    /// @param wallet The wallet that opted in.
    /// @param timestamp Block timestamp of the opt-in.
    event Activated(address indexed wallet, uint256 timestamp);

    /// @param wallet The protected wallet the check was logged for.
    /// @param txHash Hash of the transaction the agent reviewed. Not executed here.
    /// @param verdict 0 green, 1 orange, 2 red.
    event CheckLogged(address indexed wallet, bytes32 indexed txHash, uint8 verdict);

    /// @param agentId_ Agent ID token. Immutable for the life of this contract.
    constructor(address agentId_) {
        if (agentId_ == address(0)) revert ZeroAgentId();
        agentId = agentId_;
    }

    /// @notice Mark the caller as protected. Free. Idempotent.
    /// @dev The first successful call sets the latch, increments `activatedCount`,
    ///      and emits `Activated`. Later calls by the same wallet return without
    ///      an event and without changing the counter.
    function activate() external {
        if (IERC721(agentId).balanceOf(msg.sender) == 0) revert NotAgentIdHolder();
        if (_protected[msg.sender]) return;

        _protected[msg.sender] = true;
        activatedCount += 1;
        emit Activated(msg.sender, block.timestamp);
    }

    /// @notice Record that the caller reviewed a transaction before signing it.
    /// @param txHash Hash of the reviewed transaction. Stored only in the event.
    /// @param verdict 0 green, 1 orange, 2 red.
    function logCheck(bytes32 txHash, uint8 verdict) external {
        if (!_protected[msg.sender]) revert NotProtected();
        if (verdict > 2) revert InvalidVerdict();

        _checks[msg.sender] += 1;
        emit CheckLogged(msg.sender, txHash, verdict);
    }

    /// @notice Whether `wallet` has activated.
    function isProtected(address wallet) external view returns (bool) {
        return _protected[wallet];
    }

    /// @notice How many checks `wallet` has logged.
    function checkCount(address wallet) external view returns (uint256) {
        return _checks[wallet];
    }
}
