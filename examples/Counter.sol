// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Simple counter — sample for Kaspa MCP e2e deploy
contract Counter {
    uint256 public value;
    address public owner;

    event Incremented(address indexed by, uint256 newValue);

    constructor(uint256 initial) {
        owner = msg.sender;
        value = initial;
    }

    function increment() external {
        value += 1;
        emit Incremented(msg.sender, value);
    }

    function set(uint256 next) external {
        require(msg.sender == owner, "not owner");
        value = next;
    }
}
