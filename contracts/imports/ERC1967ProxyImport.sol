// SPDX-License-Identifier: MIT
// pragma range required by inherited OpenZeppelin contracts (>= 0.8.28).
// Compiled by Foundry/Hardhat at 0.8.34 — pinned in foundry.toml + hardhat.config.ts.
// ParkToken.sol (business logic) uses an exact pragma (0.8.34) and BUSL-1.1.
pragma solidity ^0.8.28;

// Re-export OZ ERC1967Proxy as a first-class contract in our project
// so Hardhat 3 generates an artifact for it. The deploy script
// (scripts/deploy/base/deploy-bsc.ts) needs the ERC1967Proxy creationCode
// to hand to the ZeframLou CREATE3 factory for deterministic proxy deployment.
//
// Thin subclass with identical runtime behaviour to OZ's canonical ERC1967Proxy.
// No additional storage or logic — just a named artifact target.

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract ParkERC1967Proxy is ERC1967Proxy {
    constructor(address implementation, bytes memory _data) ERC1967Proxy(implementation, _data) {}
}
