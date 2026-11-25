// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CustosRegistry} from "../src/CustosRegistry.sol";
import {IBalanceOf} from "../src/IBalanceOf.sol";
import {MockAgentID} from "../script/mocks/MockAgentID.sol";

contract CustosRegistryTest is Test {
    MockAgentID internal agentId;
    CustosRegistry internal registry;

    address internal holder = makeAddr("holder");
    address internal other = makeAddr("other");
    address internal stranger = makeAddr("stranger");
    address internal target = makeAddr("target");

    function setUp() public {
        agentId = new MockAgentID();
        registry = new CustosRegistry(address(agentId));
        agentId.mint(holder);
        agentId.mint(other);
    }

    function test_constructor_storesAgentId() public view {
        assertEq(registry.agentId(), address(agentId));
    }

    function test_constructor_rejectsZeroAgentId() public {
        vm.expectRevert(CustosRegistry.ZeroAgentId.selector);
        new CustosRegistry(address(0));
    }

    function test_constructor_rejectsEmptyCode() public {
        vm.expectRevert(CustosRegistry.AgentIdNotContract.selector);
        new CustosRegistry(makeAddr("eoa"));
    }

    function test_report_holderEmitsAndCounts() public {
        vm.prank(holder);
        vm.expectEmit(true, true, false, true);
        emit CustosRegistry.Reported(target, holder, 1);
        registry.report(target, 1);

        assertEq(registry.reportCount(target), 1);
        assertTrue(registry.hasReported(holder, target));
        (uint8 reason, bool active) = registry.reportOf(holder, target);
        assertEq(reason, 1);
        assertTrue(active);

        uint256[5] memory counts = registry.reasonsOf(target);
        assertEq(counts[0], 1);
        assertEq(counts[1], 0);
    }

    function test_report_nonHolderReverts() public {
        vm.prank(stranger);
        vm.expectRevert(CustosRegistry.NotAgentIdHolder.selector);
        registry.report(target, 1);

        assertEq(registry.reportCount(target), 0);
        assertFalse(registry.hasReported(stranger, target));
    }

    function test_report_duplicateReverts() public {
        vm.startPrank(holder);
        registry.report(target, 2);
        vm.expectRevert(CustosRegistry.AlreadyReported.selector);
        registry.report(target, 3);
        vm.stopPrank();

        assertEq(registry.reportCount(target), 1);
        (uint8 reason, bool active) = registry.reportOf(holder, target);
        assertEq(reason, 2);
        assertTrue(active);
        assertEq(registry.reasonsOf(target)[1], 1);
        assertEq(registry.reasonsOf(target)[2], 0);
    }

    function test_report_secondHolderCanReportSameTarget() public {
        vm.prank(holder);
        registry.report(target, 1);
        vm.prank(other);
        registry.report(target, 1);

        assertEq(registry.reportCount(target), 2);
        assertEq(registry.reasonsOf(target)[0], 2);
        assertTrue(registry.hasReported(holder, target));
        assertTrue(registry.hasReported(other, target));
    }

    function test_retract_restoresCountsAndAllowsReportAgain() public {
        vm.startPrank(holder);
        registry.report(target, 4);

        vm.expectEmit(true, true, false, true);
        emit CustosRegistry.Retracted(target, holder, 4);
        registry.retract(target);

        assertEq(registry.reportCount(target), 0);
        assertFalse(registry.hasReported(holder, target));
        (uint8 cleared, bool active) = registry.reportOf(holder, target);
        assertEq(cleared, 0);
        assertFalse(active);
        assertEq(registry.reasonsOf(target)[3], 0);

        registry.report(target, 5);
        vm.stopPrank();

        assertEq(registry.reportCount(target), 1);
        assertTrue(registry.hasReported(holder, target));
        (uint8 reason, bool again) = registry.reportOf(holder, target);
        assertEq(reason, 5);
        assertTrue(again);
        uint256[5] memory counts = registry.reasonsOf(target);
        assertEq(counts[3], 0);
        assertEq(counts[4], 1);
    }

    function test_retract_otherReporterDoesNotClear() public {
        vm.prank(holder);
        registry.report(target, 3);

        vm.prank(other);
        vm.expectRevert(CustosRegistry.NoActiveReport.selector);
        registry.retract(target);

        assertEq(registry.reportCount(target), 1);
        assertTrue(registry.hasReported(holder, target));
    }

    function test_retract_withoutReportReverts() public {
        vm.prank(holder);
        vm.expectRevert(CustosRegistry.NoActiveReport.selector);
        registry.retract(target);
    }

    function test_report_invalidReasonReverts() public {
        vm.startPrank(holder);
        vm.expectRevert(CustosRegistry.InvalidReason.selector);
        registry.report(target, 0);
        vm.expectRevert(CustosRegistry.InvalidReason.selector);
        registry.report(target, 6);
        vm.expectRevert(CustosRegistry.InvalidReason.selector);
        registry.report(target, 255);
        vm.stopPrank();

        assertEq(registry.reportCount(target), 0);
    }

    function test_report_zeroTargetReverts() public {
        vm.prank(holder);
        vm.expectRevert(CustosRegistry.ZeroTarget.selector);
        registry.report(address(0), 1);

        assertEq(registry.reportCount(address(0)), 0);
    }

    function test_reasonsOf_bucketsEachReason() public {
        address[5] memory reporters;
        for (uint8 i = 0; i < 5; i++) {
            reporters[i] = address(uint160(0xA000 + i));
            agentId.mint(reporters[i]);
            vm.prank(reporters[i]);
            registry.report(target, i + 1);
        }
        // A second drainer report, then its retraction, leaves one of each.
        agentId.mint(other);
        vm.prank(other);
        registry.report(target, 1);

        uint256[5] memory before = registry.reasonsOf(target);
        assertEq(before[0], 2);
        assertEq(before[1], 1);
        assertEq(before[2], 1);
        assertEq(before[3], 1);
        assertEq(before[4], 1);
        assertEq(registry.reportCount(target), 6);

        vm.prank(other);
        registry.retract(target);

        uint256[5] memory afterRetract = registry.reasonsOf(target);
        assertEq(afterRetract[0], 1);
        assertEq(registry.reportCount(target), 5);
        uint256 sum;
        for (uint256 i = 0; i < 5; i++) {
            sum += afterRetract[i];
        }
        assertEq(sum, registry.reportCount(target));
    }

    function test_report_rejectsValue() public {
        vm.deal(holder, 1 ether);
        vm.prank(holder);
        (bool ok,) = address(registry).call{value: 1}(abi.encodeCall(CustosRegistry.report, (target, 1)));
        assertFalse(ok);
        assertEq(registry.reportCount(target), 0);
        assertEq(address(registry).balance, 0);
    }

    /// @dev Report then optionally retract. The total always equals the five buckets.
    function testFuzz_reportRetract_preservesCounts(uint8[8] memory reasons, bool[8] memory retracts) public {
        address fuzzTarget = makeAddr("fuzz-target");
        uint256 expected;
        uint256[5] memory expectedReasons;

        for (uint256 i = 0; i < reasons.length; i++) {
            reasons[i] = uint8(bound(reasons[i], 1, 5));
            address reporter = address(uint160(0x1000 + i));
            agentId.mint(reporter);

            vm.prank(reporter);
            registry.report(fuzzTarget, reasons[i]);
            expected += 1;
            expectedReasons[reasons[i] - 1] += 1;

            if (retracts[i]) {
                vm.prank(reporter);
                registry.retract(fuzzTarget);
                expected -= 1;
                expectedReasons[reasons[i] - 1] -= 1;
                assertFalse(registry.hasReported(reporter, fuzzTarget));
                (uint8 reason, bool active) = registry.reportOf(reporter, fuzzTarget);
                assertEq(reason, 0);
                assertFalse(active);
            } else {
                assertTrue(registry.hasReported(reporter, fuzzTarget));
            }
        }

        assertEq(registry.reportCount(fuzzTarget), expected);
        uint256[5] memory counts = registry.reasonsOf(fuzzTarget);
        uint256 sum;
        for (uint256 i = 0; i < 5; i++) {
            assertEq(counts[i], expectedReasons[i]);
            sum += counts[i];
        }
        assertEq(sum, expected);
    }

    /// @dev Same reporter retracts and files a different reason. Buckets move with the total.
    function testFuzz_sameReporter_retractThenDifferentReason(uint8 first, uint8 second) public {
        first = uint8(bound(first, 1, 5));
        second = uint8(bound(second, 1, 4));
        if (second >= first) second += 1;

        vm.startPrank(holder);
        registry.report(target, first);
        registry.retract(target);
        registry.report(target, second);
        vm.stopPrank();

        assertEq(registry.reportCount(target), 1);
        assertEq(registry.reasonsOf(target)[first - 1], 0);
        assertEq(registry.reasonsOf(target)[second - 1], 1);
        (uint8 reason, bool active) = registry.reportOf(holder, target);
        assertEq(reason, second);
        assertTrue(active);

        uint256[5] memory counts = registry.reasonsOf(target);
        uint256 sum;
        for (uint256 i = 0; i < 5; i++) {
            sum += counts[i];
        }
        assertEq(sum, registry.reportCount(target));
    }

    function test_retract_afterLostId_decrementsCounts() public {
        vm.prank(holder);
        registry.report(target, 3);
        _setBalance(holder, 0);

        vm.prank(holder);
        vm.expectEmit(true, true, false, true);
        emit CustosRegistry.Retracted(target, holder, 3);
        registry.retract(target);

        assertEq(registry.reportCount(target), 0);
        assertEq(registry.reasonsOf(target)[2], 0);
        assertFalse(registry.hasReported(holder, target));
        (uint8 reason, bool active) = registry.reportOf(holder, target);
        assertEq(reason, 0);
        assertFalse(active);
    }

    function test_retract_neverHeld_reverts() public {
        _setBalance(stranger, 0);
        vm.prank(stranger);
        vm.expectRevert(CustosRegistry.NoActiveReport.selector);
        registry.retract(target);
        assertEq(registry.reportCount(target), 0);
    }

    function test_retract_strangerNeverHeld_doesNotClear() public {
        vm.prank(holder);
        registry.report(target, 1);
        _setBalance(stranger, 0);

        vm.prank(stranger);
        vm.expectRevert(CustosRegistry.NoActiveReport.selector);
        registry.retract(target);

        assertEq(registry.reportCount(target), 1);
        assertEq(registry.reasonsOf(target)[0], 1);
        assertTrue(registry.hasReported(holder, target));
    }

    function test_retract_twice_reverts() public {
        vm.startPrank(holder);
        registry.report(target, 2);
        registry.retract(target);
        vm.expectRevert(CustosRegistry.NoActiveReport.selector);
        registry.retract(target);
        vm.stopPrank();

        assertEq(registry.reportCount(target), 0);
        assertEq(registry.reasonsOf(target)[1], 0);
    }

    function test_report_afterLostId_reverts() public {
        address otherTarget = makeAddr("other-target");
        vm.prank(holder);
        registry.report(target, 4);
        _setBalance(holder, 0);

        vm.prank(holder);
        vm.expectRevert(CustosRegistry.NotAgentIdHolder.selector);
        registry.report(otherTarget, 1);

        assertEq(registry.reportCount(target), 1);
        assertEq(registry.reportCount(otherTarget), 0);
        assertEq(registry.reasonsOf(target)[3], 1);
        (uint8 reason, bool active) = registry.reportOf(holder, target);
        assertEq(reason, 4);
        assertTrue(active);
    }

    function test_report_duplicateRevertsBeforeHolderCheck() public {
        vm.prank(holder);
        registry.report(target, 2);
        _setBalance(holder, 0);

        vm.prank(holder);
        vm.expectRevert(CustosRegistry.AlreadyReported.selector);
        registry.report(target, 5);

        assertEq(registry.reportCount(target), 1);
        assertEq(registry.reasonsOf(target)[1], 1);
        (uint8 reason, bool active) = registry.reportOf(holder, target);
        assertEq(reason, 2);
        assertTrue(active);
    }

    function test_retract_rejectsValue() public {
        vm.prank(holder);
        registry.report(target, 1);
        vm.deal(holder, 1 ether);
        vm.prank(holder);
        (bool ok,) = address(registry).call{value: 1}(abi.encodeCall(CustosRegistry.retract, (target)));
        assertFalse(ok);
        assertEq(registry.reportCount(target), 1);
        assertTrue(registry.hasReported(holder, target));
        assertEq(address(registry).balance, 0);
    }

    function _setBalance(address account, uint256 amount) internal {
        vm.mockCall(address(agentId), abi.encodeCall(IBalanceOf.balanceOf, (account)), abi.encode(amount));
    }
}
