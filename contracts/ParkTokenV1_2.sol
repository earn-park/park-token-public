// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {
    ERC20PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import {ParkTokenV1_1} from "./ParkTokenV1_1.sol";

/// @title ParkTokenV1_2
/// @notice PARK — adds a global pause circuit-breaker on top of
///         `ParkTokenV1_1` (admin `mint` already removed). This change does
///         **one thing**: introduce `pause`/`unpause` under a dedicated
///         `PAUSER_ROLE`.
///
///         The contract **REMAINS UUPS-upgradeable** — `_authorizeUpgrade` is
///         inherited unchanged (`UPGRADER_ROLE`, Timelock-gated). Renouncing
///         upgradeability is a **separate, later step** (a future terminal
///         impl), not this one.
///
/// @dev Inherits `ParkTokenV1_1` (no mint, strictly non-increasing supply) +
///      `ERC20Pausable`. Storage = the deployed v1.0.0 layout plus the additive
///      `openzeppelin.storage.Pausable` ERC-7201 namespace (no collision;
///      `_paused` defaults to false). `PAUSER_ROLE` keeps the default
///      `DEFAULT_ADMIN_ROLE` admin, so the admin Safe can rotate the pauser
///      without an upgrade. The role is granted once via `reinitializePauser`.
contract ParkTokenV1_2 is ParkTokenV1_1, ERC20PausableUpgradeable {
    /// @notice Holder of the global pause circuit-breaker. Distinct from
    ///         DEFAULT_ADMIN so pause authority is isolated from metadata /
    ///         rescuer authority; intended for the emergency Safe.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    error ZeroPauser();

    /// @notice Re-initializer (consumes `reinitializer(2)`) executed inside the
    ///         `upgradeToAndCall` payload that swaps the proxy to this impl.
    ///         Grants `PAUSER_ROLE` to `pauser`.
    /// @param pauser Emergency multisig Safe to receive `PAUSER_ROLE`. Must be
    ///        non-zero; SHOULD be a multisig (a lost/compromised pauser could
    ///        pause the token).
    function reinitializePauser(address pauser) external onlyRole(UPGRADER_ROLE) reinitializer(2) {
        if (pauser == address(0)) revert ZeroPauser();
        _grantRole(PAUSER_ROLE, pauser);
    }

    /// @notice Pause all token transfers and burns (global circuit-breaker).
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resume operations after a pause.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Implementation marker. Still upgradeable (not terminal).
    function implVersion() public pure virtual override returns (string memory) {
        return "v1.2.0";
    }

    /// @dev C3-linearized override chain: ERC20Pausable (`whenNotPaused`) →
    ///      ParkTokenV1_1 → ERC20Capped (cap) → ERC20 (balances). A paused
    ///      token reverts `EnforcedPause` on any transfer/burn.
    function _update(address from, address to, uint256 value)
        internal
        virtual
        override(ParkTokenV1_1, ERC20PausableUpgradeable)
    {
        super._update(from, to, value);
    }

    /// @dev Disambiguate `decimals()` between ParkTokenV1_1 (pure → 6) and
    ///      ERC20Upgradeable (view → 18). The 6-decimals value wins.
    function decimals() public pure virtual override(ParkTokenV1_1, ERC20Upgradeable) returns (uint8) {
        return ParkTokenV1_1.decimals();
    }
}
