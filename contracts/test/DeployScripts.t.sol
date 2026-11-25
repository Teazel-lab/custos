// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployMainnet} from "../script/DeployMainnet.s.sol";
import {DeployTestnet} from "../script/DeployTestnet.s.sol";
import {MockAgentID} from "../script/mocks/MockAgentID.sol";
import {CustosHub} from "../src/CustosHub.sol";
import {CustosRegistry} from "../src/CustosRegistry.sol";

contract DeployScriptsTest is Test {
    function test_mainnet_revertsOnUnexpectedChain() public {
        DeployMainnet deployed = new DeployMainnet();

        vm.expectRevert(abi.encodeWithSelector(DeployMainnet.UnexpectedChain.selector, block.chainid));
        deployed.run();

        vm.chainId(97);
        vm.expectRevert(abi.encodeWithSelector(DeployMainnet.UnexpectedChain.selector, uint256(97)));
        deployed.run();
    }

    function test_testnet_revertsOnUnexpectedChain() public {
        DeployTestnet deployed = new DeployTestnet();

        vm.expectRevert(abi.encodeWithSelector(DeployTestnet.UnexpectedChain.selector, block.chainid));
        deployed.run();

        vm.chainId(56);
        vm.expectRevert(abi.encodeWithSelector(DeployTestnet.UnexpectedChain.selector, uint256(56)));
        deployed.run();
    }

    function test_testnet_deploysAgainstMock() public {
        vm.chainId(97);
        DeployTestnet deployed = new DeployTestnet();
        deployed.run();

        address agentId = address(deployed.deployedAgentId());
        assertEq(CustosHub(deployed.deployedHub()).agentId(), agentId);
        assertEq(CustosRegistry(deployed.deployedRegistry()).agentId(), agentId);
    }

    function test_mainnet_deploysAgainstAgentId() public {
        address agentId = 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F;
        MockAgentID mock = new MockAgentID();
        vm.etch(agentId, address(mock).code);
        vm.chainId(56);

        DeployMainnet deployed = new DeployMainnet();
        deployed.run();

        assertEq(CustosHub(deployed.deployedHub()).agentId(), agentId);
        assertEq(CustosRegistry(deployed.deployedRegistry()).agentId(), agentId);
    }
}
