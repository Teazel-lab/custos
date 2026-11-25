// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockAgentID
/// @notice Test-only stand-in for Agent ID. Custos only reads `balanceOf`.
/// @dev Not for mainnet. `mint` is open and this token is not soulbound.
///      The chain 97 script deploys it. Do not point a mainnet hub or registry at it.
contract MockAgentID {
    mapping(address owner => uint256) public balanceOf;

    uint256 public nextId = 1;

    /// @notice `to` was the zero address.
    error ZeroAddress();

    /// @notice Give `to` one balance unit and return the mock token id.
    function mint(address to) external returns (uint256 tokenId) {
        if (to == address(0)) revert ZeroAddress();
        tokenId = nextId++;
        balanceOf[to] += 1;
    }
}
