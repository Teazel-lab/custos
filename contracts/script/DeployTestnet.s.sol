// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MockAgentID} from "./mocks/MockAgentID.sol";
import {CustosHub} from "../src/CustosHub.sol";
import {CustosRegistry} from "../src/CustosRegistry.sol";

/// @notice Deploy MockAgentID, CustosHub, and CustosRegistry on chain 97.
/// @dev The signer comes from `forge script --account`. This file does not
///      read or embed a key.
contract DeployTestnet is Script {
    error UnexpectedChain(uint256 chainId);

    function run() external {
        if (block.chainid != 97) revert UnexpectedChain(block.chainid);

        vm.startBroadcast();
        MockAgentID agentId = new MockAgentID();
        CustosHub hub = new CustosHub(address(agentId));
        CustosRegistry registry = new CustosRegistry(address(agentId));
        vm.stopBroadcast();

        console.log("chainId:", block.chainid);
        console.log("MockAgentID:", address(agentId));
        console.log("CustosHub:", address(hub));
        console.log("CustosRegistry:", address(registry));
    }
}
