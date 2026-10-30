// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Community tip jar — demo for kaspa-mcp
contract CommunityTipJar {
    address public owner;
    uint256 public totalTips;
    mapping(address => uint256) public tipsOf;

    event Tipped(address indexed from, uint256 amount, string note);
    event Withdrawn(address indexed to, uint256 amount);

    constructor() {
        owner = msg.sender;
    }

    function tip(string calldata note) external payable {
        require(msg.value > 0, "send value");
        tipsOf[msg.sender] += msg.value;
        totalTips += msg.value;
        emit Tipped(msg.sender, msg.value, note);
    }

    function withdraw() external {
        require(msg.sender == owner, "not owner");
        uint256 bal = address(this).balance;
        require(bal > 0, "empty");
        (bool ok, ) = payable(owner).call{value: bal}("");
        require(ok, "xfer failed");
        emit Withdrawn(owner, bal);
    }

    receive() external payable {
        tipsOf[msg.sender] += msg.value;
        totalTips += msg.value;
        emit Tipped(msg.sender, msg.value, "");
    }
}
