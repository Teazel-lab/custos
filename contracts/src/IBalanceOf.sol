// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IBalanceOf
/// @notice The only Agent ID read Custos performs.
/// @dev `view` so the compiler emits STATICCALL. The token cannot reenter.
interface IBalanceOf {
    function balanceOf(address account) external view returns (uint256);
}
