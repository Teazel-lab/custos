// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IBalanceOf} from "./IBalanceOf.sol";

/// @title CustosHub
/// @notice Opt-in log for an agent that already ran a pre-sign check.
/// @dev No owner, no admin, no proxy, and no payable function. The Agent ID
///      token is fixed at construction. The first `activate` requires a holder.
///      A later call from a protected wallet returns immediately and does not
///      read Agent ID. `logCheck` does not store verdicts. It increments a
///      per-wallet counter and emits the verdict. Protection is a latch;
///      `logCheck` does not re-read Agent ID.
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

    /// @notice `agentId` has no code.
    error AgentIdNotContract();

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
    /// @param timestamp Block timestamp of the log.
    event CheckLogged(address indexed wallet, bytes32 indexed txHash, uint8 verdict, uint256 timestamp);

    /// @param agentId_ Agent ID token. Immutable for the life of this contract.
    constructor(address agentId_) {
        if (agentId_ == address(0)) revert ZeroAgentId();
        if (agentId_.code.length == 0) revert AgentIdNotContract();
        agentId = agentId_;
    }

    /// @notice Mark the caller as protected.
    /// @dev The first call requires Agent ID, sets the latch, increments
    ///      `activatedCount`, and emits `Activated`. A later call from a wallet
    ///      that is already protected returns immediately and does not read Agent ID.
    function activate() external {
        if (_protected[msg.sender]) return;
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (IBalanceOf(agentId).balanceOf(msg.sender) == 0) revert NotAgentIdHolder();

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
        emit CheckLogged(msg.sender, txHash, verdict, block.timestamp);
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
