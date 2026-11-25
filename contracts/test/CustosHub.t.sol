// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CustosHub} from "../src/CustosHub.sol";
import {IBalanceOf} from "../src/IBalanceOf.sol";
import {MockAgentID} from "../script/mocks/MockAgentID.sol";

contract CustosHubTest is Test {
    MockAgentID internal agentId;
    CustosHub internal hub;

    address internal holder = makeAddr("holder");
    address internal other = makeAddr("other");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        agentId = new MockAgentID();
        hub = new CustosHub(address(agentId));
        agentId.mint(holder);
        agentId.mint(other);
    }

    function test_constructor_storesAgentId() public view {
        assertEq(hub.agentId(), address(agentId));
    }

    function test_constructor_rejectsZeroAgentId() public {
        vm.expectRevert(CustosHub.ZeroAgentId.selector);
        new CustosHub(address(0));
    }

    function test_constructor_rejectsEmptyCode() public {
        vm.expectRevert(CustosHub.AgentIdNotContract.selector);
        new CustosHub(makeAddr("eoa"));
    }

    function test_activate_holderMarksProtectedAndEmits() public {
        vm.prank(holder);
        vm.expectEmit(true, false, false, true);
        emit CustosHub.Activated(holder, block.timestamp);
        hub.activate();

        assertTrue(hub.isProtected(holder));
        assertEq(hub.activatedCount(), 1);
        assertEq(hub.checkCount(holder), 0);
    }

    function test_activate_isIdempotent() public {
        vm.startPrank(holder);
        hub.activate();

        vm.recordLogs();
        hub.activate();
        vm.stopPrank();

        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(hub.activatedCount(), 1);
        assertTrue(hub.isProtected(holder));
    }

    function test_activate_countsDistinctWallets() public {
        vm.prank(holder);
        hub.activate();
        vm.prank(other);
        hub.activate();
        vm.prank(holder);
        hub.activate();

        assertEq(hub.activatedCount(), 2);
        assertTrue(hub.isProtected(other));
        assertFalse(hub.isProtected(stranger));
    }

    function test_activate_nonHolderReverts() public {
        vm.prank(stranger);
        vm.expectRevert(CustosHub.NotAgentIdHolder.selector);
        hub.activate();

        assertFalse(hub.isProtected(stranger));
        assertEq(hub.activatedCount(), 0);
    }

    function test_activate_rejectsValue() public {
        vm.deal(holder, 1 ether);
        vm.prank(holder);
        (bool ok,) = address(hub).call{value: 1}(abi.encodeCall(CustosHub.activate, ()));
        assertFalse(ok);
        assertFalse(hub.isProtected(holder));
        assertEq(address(hub).balance, 0);
    }

    function test_logCheck_revertsWhenNotProtected() public {
        vm.prank(holder);
        vm.expectRevert(CustosHub.NotProtected.selector);
        hub.logCheck(keccak256("tx"), 0);

        vm.prank(stranger);
        vm.expectRevert(CustosHub.NotProtected.selector);
        hub.logCheck(keccak256("tx"), 1);

        assertEq(hub.checkCount(holder), 0);
    }

    function test_logCheck_revertsOnInvalidVerdict() public {
        vm.startPrank(holder);
        hub.activate();
        vm.expectRevert(CustosHub.InvalidVerdict.selector);
        hub.logCheck(keccak256("tx"), 3);
        vm.expectRevert(CustosHub.InvalidVerdict.selector);
        hub.logCheck(keccak256("tx"), 255);
        vm.stopPrank();

        assertEq(hub.checkCount(holder), 0);
    }

    function test_logCheck_recordsVerdictsAndPerWalletCount() public {
        bytes32 first = keccak256("first");
        bytes32 second = keccak256("second");

        vm.startPrank(holder);
        hub.activate();
        vm.expectEmit(true, true, false, true);
        emit CustosHub.CheckLogged(holder, first, 0, block.timestamp);
        hub.logCheck(first, 0);
        vm.expectEmit(true, true, false, true);
        emit CustosHub.CheckLogged(holder, second, 1, block.timestamp);
        hub.logCheck(second, 1);
        vm.expectEmit(true, true, false, true);
        emit CustosHub.CheckLogged(holder, second, 2, block.timestamp);
        hub.logCheck(second, 2);
        vm.stopPrank();

        vm.startPrank(other);
        hub.activate();
        hub.logCheck(first, 2);
        vm.stopPrank();

        assertEq(hub.checkCount(holder), 3);
        assertEq(hub.checkCount(other), 1);
        assertEq(hub.checkCount(stranger), 0);
    }

    function test_logCheck_afterLostId_stillLogs() public {
        bytes32 hash = keccak256("latched");
        vm.prank(holder);
        hub.activate();
        _setBalance(holder, 0);

        vm.prank(holder);
        vm.expectEmit(true, true, false, true);
        emit CustosHub.CheckLogged(holder, hash, 2, block.timestamp);
        hub.logCheck(hash, 2);

        assertTrue(hub.isProtected(holder));
        assertEq(hub.checkCount(holder), 1);
    }

    function test_activate_afterLostId_secondCallIsNoop() public {
        vm.prank(holder);
        hub.activate();
        _setBalance(holder, 0);

        vm.prank(holder);
        vm.recordLogs();
        hub.activate();

        assertEq(vm.getRecordedLogs().length, 0);
        assertTrue(hub.isProtected(holder));
        assertEq(hub.activatedCount(), 1);
    }

    function test_logCheck_rejectsValue() public {
        vm.prank(holder);
        hub.activate();
        vm.deal(holder, 1 ether);
        vm.prank(holder);
        (bool ok,) = address(hub).call{value: 1}(abi.encodeCall(CustosHub.logCheck, (keccak256("tx"), 1)));
        assertFalse(ok);
        assertEq(hub.checkCount(holder), 0);
        assertEq(address(hub).balance, 0);
    }

    function _setBalance(address account, uint256 amount) internal {
        vm.mockCall(address(agentId), abi.encodeCall(IBalanceOf.balanceOf, (account)), abi.encode(amount));
    }
}
