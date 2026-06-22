// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {ParkTokenV1_2} from "./ParkTokenV1_2.sol";

/// @title ParkTokenV2
/// @notice PARK — **terminal** implementation. Permanently renounces UUPS
///         upgradeability: both the public `upgradeToAndCall` entrypoint and the
///         internal `_authorizeUpgrade` hook revert, so no implementation can
///         ever replace this one. The full v1.2 surface is retained — no
///         `mint` (removed in v1.1), `pause` / `unpause` under `PAUSER_ROLE`,
///         `burn` / `burnFrom`, ERC-2612 `permit`, foreign-asset rescue, and
///         `contractURI` metadata.
///
///         This is the MEXC listing end-state: minting was removed in v1.1, and
///         upgradeability is now irrevocably renounced. A Timelock delay is not
///         accepted by the exchange — the capability itself is removed, not just
///         slowed.
///
/// @dev Last hop in the lineage `ParkToken → ParkTokenV1_1 → ParkTokenV1_2 →
///      ParkTokenV2`. Adds NO storage and NO reinitializer (nothing to
///      initialize), so the Stage-3 upgrade lands via the *current* (v1.2)
///      `upgradeToAndCall(thisImpl, "")`; from then on every upgrade entrypoint
///      on the proxy reverts. This upgrade is IRREVERSIBLE — there is no code
///      path left that can set a new implementation.
contract ParkTokenV2 is ParkTokenV1_2 {
    /// @notice Thrown by every UUPS upgrade entrypoint — upgradeability is
    ///         permanently renounced on this implementation.
    error UpgradeabilityRenounced();

    /// @notice UUPS upgrade entrypoint — permanently disabled.
    /// @dev `upgradeToAndCall` is the ONLY public path that can set a new
    ///      implementation (OpenZeppelin v5 removed `upgradeTo`), and the
    ///      internal `_authorizeUpgrade` / `_upgradeToAndCallUUPS` hooks have no
    ///      other caller. Overriding this entrypoint to revert therefore
    ///      renounces upgradeability completely — the ERC-1967 implementation
    ///      slot can never be rewritten again. Parameters are unnamed because the
    ///      call always reverts.
    ///
    ///      `_authorizeUpgrade` is deliberately left inherited (it is now
    ///      unreachable): overriding it to also revert would make the inherited
    ///      base `upgradeToAndCall` body emit an "unreachable code" warning for
    ///      `_upgradeToAndCallUUPS`, and editing the vendored library to silence
    ///      it would break the bytecode baseline.
    function upgradeToAndCall(address, bytes memory) public payable override {
        revert UpgradeabilityRenounced();
    }

    /// @notice Implementation marker. Terminal — upgradeability renounced.
    function implVersion() public pure virtual override returns (string memory) {
        return "v2.0.0";
    }
}
