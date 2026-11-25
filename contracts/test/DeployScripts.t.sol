// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployMainnet} from "../script/DeployMainnet.s.sol";
import {DeployTestnet} from "../script/DeployTestnet.s.sol";

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
}
