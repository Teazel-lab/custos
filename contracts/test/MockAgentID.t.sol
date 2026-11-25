// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockAgentID} from "../script/mocks/MockAgentID.sol";

contract MockAgentIDTest is Test {
    function test_mint_rejectsZeroAddress() public {
        MockAgentID agentId = new MockAgentID();
        vm.expectRevert(MockAgentID.ZeroAddress.selector);
        agentId.mint(address(0));
        assertEq(agentId.balanceOf(address(0)), 0);
        assertEq(agentId.nextId(), 1);
    }

    function test_mint_incrementsBalance() public {
        MockAgentID agentId = new MockAgentID();
        address to = makeAddr("to");
        assertEq(agentId.mint(to), 1);
        assertEq(agentId.balanceOf(to), 1);
        assertEq(agentId.mint(to), 2);
        assertEq(agentId.balanceOf(to), 2);
    }
}
