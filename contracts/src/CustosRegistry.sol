// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IBalanceOf} from "./IBalanceOf.sol";

/// @title CustosRegistry
/// @notice Community reports filed by Agent ID holders against contract addresses.
/// @dev No owner and no admin. One active report per reporter per target.
///      To change a reason, the reporter retracts and reports again.
///      `retract` does not re-check Agent ID; only the original reporter can
///      withdraw their own active report. There is no name lookup; targets
///      and reporters are addresses.
contract CustosRegistry {
    /// @notice Reason codes. `reasonsOf` index `n` counts reason `n + 1`.
    uint8 internal constant REASON_DRAINER = 1;
    uint8 internal constant REASON_HONEYPOT = 2;
    uint8 internal constant REASON_PHISHING = 3;
    uint8 internal constant REASON_MINT_RUG = 4;
    uint8 internal constant REASON_OTHER = 5;

    /// @notice Agent ID token. Holder check is `balanceOf(addr) > 0`.
    address public immutable agentId;

    /// @notice Active reports currently filed against a target.
    mapping(address target => uint256) public reportCount;

    mapping(address target => mapping(uint8 reason => uint256)) private _reasonCount;
    mapping(address reporter => mapping(address target => Report)) private _reports;

    struct Report {
        uint8 reason;
        bool active;
    }

    /// @notice The caller does not hold Agent ID.
    error NotAgentIdHolder();

    /// @notice `agentId` was the zero address.
    error ZeroAgentId();

    /// @notice `agentId` has no code.
    error AgentIdNotContract();

    /// @notice `target` was the zero address.
    error ZeroTarget();

    /// @notice Reason was not in 1..5.
    error InvalidReason();

    /// @notice This reporter already has an active report on the target.
    error AlreadyReported();

    /// @notice This reporter has no active report on the target.
    error NoActiveReport();

    /// @param target Address the report is about. A contract or an EOA.
    /// @param reporter Agent ID holder who filed it.
    /// @param reason 1 drainer, 2 honeypot, 3 phishing approval or permit,
    ///        4 owner can mint or rug, 5 other.
    event Reported(address indexed target, address indexed reporter, uint8 reason);

    /// @param target Address the report was about.
    /// @param reporter Agent ID holder who withdrew it.
    /// @param reason The reason that was withdrawn.
    event Retracted(address indexed target, address indexed reporter, uint8 reason);

    /// @param agentId_ Agent ID token. Immutable for the life of this contract.
    constructor(address agentId_) {
        if (agentId_ == address(0)) revert ZeroAgentId();
        if (agentId_.code.length == 0) revert AgentIdNotContract();
        agentId = agentId_;
    }

    /// @notice File one active report against `target`.
    /// @param target Any non-zero address, contract or EOA.
    /// @param reason 1 drainer, 2 honeypot, 3 phishing approval or permit,
    ///        4 owner can mint or rug, 5 other.
    function report(address target, uint8 reason) external {
        if (target == address(0)) revert ZeroTarget();
        if (reason == 0 || reason > REASON_OTHER) revert InvalidReason();

        Report storage filed = _reports[msg.sender][target];
        if (filed.active) revert AlreadyReported();

        // Holder read happens before this call writes.
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (IBalanceOf(agentId).balanceOf(msg.sender) == 0) revert NotAgentIdHolder();

        filed.active = true;
        filed.reason = reason;
        reportCount[target] += 1;
        _reasonCount[target][reason] += 1;

        emit Reported(target, msg.sender, reason);
    }

    /// @notice Withdraw the caller's active report on `target`.
    /// @dev Decrements the target total and that reason's count. The same
    ///      reporter can `report` this target again afterwards.
    function retract(address target) external {
        Report storage filed = _reports[msg.sender][target];
        if (!filed.active) revert NoActiveReport();

        uint8 reason = filed.reason;
        filed.active = false;
        filed.reason = 0;
        reportCount[target] -= 1;
        _reasonCount[target][reason] -= 1;

        emit Retracted(target, msg.sender, reason);
    }

    /// @notice Active reports on `target`, grouped by reason.
    /// @return counts `[drainer, honeypot, phishing, mintOrRug, other]`.
    ///         Index 0 is reason 1. Index 4 is reason 5.
    function reasonsOf(address target) external view returns (uint256[5] memory counts) {
        counts[0] = _reasonCount[target][REASON_DRAINER];
        counts[1] = _reasonCount[target][REASON_HONEYPOT];
        counts[2] = _reasonCount[target][REASON_PHISHING];
        counts[3] = _reasonCount[target][REASON_MINT_RUG];
        counts[4] = _reasonCount[target][REASON_OTHER];
    }

    /// @notice Whether `reporter` has an active report on `target`.
    function hasReported(address reporter, address target) external view returns (bool) {
        return _reports[reporter][target].active;
    }

    /// @notice Report row for `reporter` on `target`. `reason` is 0 when `active` is false.
    function reportOf(address reporter, address target) external view returns (uint8 reason, bool active) {
        Report storage filed = _reports[reporter][target];
        return (filed.reason, filed.active);
    }
}
