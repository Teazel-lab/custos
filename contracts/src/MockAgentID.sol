// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockAgentID
/// @notice Test and testnet stand-in for Agent ID. Custos only reads `balanceOf`.
/// @dev `mint` is open and this token is not soulbound. Do not deploy it on
///      mainnet and do not point a mainnet hub or registry at it. Mainnet uses
///      the Agent ID token at 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F.
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
