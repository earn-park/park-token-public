// SPDX-License-Identifier: MIT
// pragma range required by inherited OpenZeppelin contracts (>= 0.8.28).
// Compiled by Foundry/Hardhat at 0.8.34 — pinned in foundry.toml + hardhat.config.ts.
// ParkToken.sol (business logic) uses an exact pragma (0.8.34) and BUSL-1.1.
pragma solidity ^0.8.28;

// Re-export OZ TimelockController as a first-class contract in our project
// so Hardhat 3 generates a standalone artifact for it. Identical runtime
// behaviour to OZ TimelockController v5.6.1.
//
// Used by deploy-bsc.ts when deploying the Timelock that holds
// UPGRADER_ROLE on the ParkToken proxy.

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

contract ParkTimelockController is TimelockController {
    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors, address admin)
        TimelockController(minDelay, proposers, executors, admin)
    {}
}
