// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {CustosHub} from "../src/CustosHub.sol";
import {CustosRegistry} from "../src/CustosRegistry.sol";

/// @notice Deploy CustosHub and CustosRegistry on chain 56 against Agent ID.
/// @dev The signer comes from `forge script --account` or `--private-key`.
///      This file does not read or embed a key. It does not deploy a mock.
contract DeployMainnet is Script {
    /// @dev Verified soulbound Agent ID token on chain 56.
    address internal constant AGENT_ID = 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F;

    error UnexpectedChain(uint256 chainId);

    function run() external {
        if (block.chainid != 56) revert UnexpectedChain(block.chainid);

        vm.startBroadcast();
        CustosHub hub = new CustosHub(AGENT_ID);
        CustosRegistry registry = new CustosRegistry(AGENT_ID);
        vm.stopBroadcast();

        console.log("chainId:", block.chainid);
        console.log("AgentID:", AGENT_ID);
        console.log("CustosHub:", address(hub));
        console.log("CustosRegistry:", address(registry));
    }
}
