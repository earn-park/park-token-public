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
// Thin subclass of OZ's canonical ERC1967Proxy with one added constructor
// guard. No runtime storage and no runtime code path — the check lives entirely
// in the constructor.
//
// Guard rationale: OZ's base constructor already reverts on empty `_data`
// (ERC1967ProxyUninitialized) and delegatecalls non-empty `_data` into the
// implementation at construction time, so a correct initialize() runs
// atomically with the deploy and cannot be front-run. The residual gap it does
// NOT close: non-empty `_data` whose selector is a non-reverting, non-init
// function (e.g. a view such as decimals()). That delegatecall succeeds, the
// proxy deploys, yet initialize() is never consumed and stays front-runnable.
// Requiring the selector to be ParkToken.initialize closes that gap on-chain.
//
// The selector is hardcoded (not derived via `import {ParkToken}`) to keep this
// MIT, dependency-light artifact decoupled from the BUSL-1.1 token compile
// graph. Drift is caught by test/ParkERC1967Proxy.t.sol, which asserts the
// constant equals ParkToken.initialize.selector.
//
// CREATE3 derives the deployed address from (factory, deployer, salt) and the
// factory's own minimal-proxy initcode hash — never from this contract's
// creation code — so the guard does NOT change the deterministic proxy address;
// it only changes the ParkERC1967Proxy bytecode baseline.

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract ParkERC1967Proxy is ERC1967Proxy {
    /// @dev keccak256("initialize((address,uint48,address,address,address,string))")[:4],
    ///      i.e. ParkToken.initialize(InitConfig). Pinned against the live ABI
    ///      in test/ParkERC1967Proxy.t.sol.
    bytes4 private constant INITIALIZE_SELECTOR = 0x14bf9d35;

    /// @notice Constructor `_data` did not invoke ParkToken.initialize.
    /// @param provided The leading 4 bytes of `_data` (zero if shorter).
    /// @param expected The required initialize(InitConfig) selector.
    error UnexpectedInitSelector(bytes4 provided, bytes4 expected);

    constructor(address implementation, bytes memory _data) payable ERC1967Proxy(implementation, _data) {
        bytes4 provided;
        if (_data.length >= 4) {
            assembly {
                provided := mload(add(_data, 0x20))
            }
        }
        if (provided != INITIALIZE_SELECTOR) {
            revert UnexpectedInitSelector(provided, INITIALIZE_SELECTOR);
        }
    }
}
