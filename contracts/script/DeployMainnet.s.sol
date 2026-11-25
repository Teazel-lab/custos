// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IBalanceOf} from "../src/IBalanceOf.sol";
import {CustosHub} from "../src/CustosHub.sol";
import {CustosRegistry} from "../src/CustosRegistry.sol";

/// @dev Used only by this script to probe the token before deploy.
interface IERC165Probe {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @notice Deploy CustosHub and CustosRegistry on chain 56 against Agent ID.
/// @dev The signer comes from `forge script --account`. This file does not
///      read or embed a key. It does not deploy a mock.
contract DeployMainnet is Script {
    /// @dev Verified soulbound Agent ID token on chain 56.
    address internal constant AGENT_ID = 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F;

    bytes4 internal constant ERC165_ID = 0x01ffc9a7;
    bytes4 internal constant ERC721_ID = 0x80ac58cd;

    CustosHub public deployedHub;
    CustosRegistry public deployedRegistry;

    error UnexpectedChain(uint256 chainId);
    error AgentIdNotERC721();

    function run() external {
        if (block.chainid != 56) revert UnexpectedChain(block.chainid);

        // Must succeed. A contract that does not answer balanceOf fails the run.
        IBalanceOf(AGENT_ID).balanceOf(msg.sender);
        _requireErc721IfErc165();

        vm.startBroadcast();
        deployedHub = new CustosHub(AGENT_ID);
        deployedRegistry = new CustosRegistry(AGENT_ID);
        vm.stopBroadcast();

        console.log("chainId:", block.chainid);
        console.log("AgentID:", AGENT_ID);
        console.log("CustosHub:", address(deployedHub));
        console.log("CustosRegistry:", address(deployedRegistry));
    }

    /// @dev If the token answers ERC165 and claims support, it must be ERC-721.
    ///      A token with no ERC165 (the call reverts) is allowed through.
    function _requireErc721IfErc165() internal view {
        try IERC165Probe(AGENT_ID).supportsInterface(ERC165_ID) returns (bool erc165) {
            if (!erc165) return;
            try IERC165Probe(AGENT_ID).supportsInterface(ERC721_ID) returns (bool is721) {
                if (!is721) revert AgentIdNotERC721();
            } catch {
                revert AgentIdNotERC721();
            }
        } catch {}
    }
}
