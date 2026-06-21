// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {
    ERC20BurnableUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import {
    ERC20PermitUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {
    ERC20CappedUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20CappedUpgradeable.sol";
import {
    AccessControlDefaultAdminRulesUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlDefaultAdminRulesUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title ParkTokenV1_1
/// @notice PARK — ERC-20 utility token for the EarnPark ecosystem.
///         **v1.1.0 — Stage 1 of the renounce path:** the admin `mint`
///         function present in v1.0.0 (`ParkToken`) is **removed entirely**.
///         There is no longer any code path that increases `totalSupply()`:
///         supply is strictly non-increasing (holder `burn`/`burnFrom` only).
///         Everything else is byte-for-byte the v1.0.0 surface and storage
///         layout. The contract REMAINS UUPS-upgradeable — freezing the
///         upgrade path is the separate, terminal Stage 2.
///
/// @dev Upgrade-safety: this implementation keeps the exact inheritance order
///      and the same ERC-7201 namespace (`earnpark.storage.ParkToken.Metadata`
///      at the identical slot) as `ParkToken`, so the storage layout is
///      unchanged. Removing a function does not affect storage. Equivalence
///      with the deployed v1.0.0 layout is checked via a forge storage-layout
///      diff and by the OZ Upgrades validator at deploy time.
///
/// @dev Feature surface (unchanged from v1.0.0 except mint removal):
///        - ERC-20 + Burnable + Permit (EIP-2612)
///        - Capped: `cap()` returns `INITIAL_SUPPLY` via `pure` override.
///        - AccessControlDefaultAdminRules — 2-step admin transfer with
///          24h ≤ delay ≤ 30d bounds at init AND post-init.
///        - UUPSUpgradeable — UPGRADER_ROLE admin hardened to
///          TIMELOCK_ADMIN_ROLE (self-administered).
///        - Rescue ERC-20 + ETH (USDC pattern). Hard invariants
///          `CannotRescueSelf` and `RescueRecipientIsSelf`.
///        - Metadata (contractURI + DEFAULT_ADMIN-gated setter, non-empty).
///        - `implVersion()` virtual, bumped to "v1.1.0".
///
///      **Roles** — three runtime roles plus a self-administered
///      admin-of-admin:
///        - `DEFAULT_ADMIN_ROLE` — multisig admin (Safe with HW wallets):
///          sets metadata, grants/revokes `RESCUER_ROLE`. **No mint.**
///        - `UPGRADER_ROLE` — Timelock: authorizes UUPS upgrades.
///        - `TIMELOCK_ADMIN_ROLE` — admin of `UPGRADER_ROLE`,
///          self-administered, granted only to the Timelock.
///        - `RESCUER_ROLE` — Safe or dedicated recovery operator.
///
///      **Supply semantics** — fixed cap, **strictly non-increasing supply**.
///      `INITIAL_SUPPLY` was minted once at v1.0.0 init. With `mint` removed,
///      `totalSupply()` can only ever decrease via holder `burn`/`burnFrom`;
///      no role (including DEFAULT_ADMIN) can re-issue burned supply. The cap
///      is a hard ceiling that is now never approached from below.
///
///      **Storage** — single ERC-7201 namespace
///      `earnpark.storage.ParkToken.Metadata` declared in this contract;
///      the inherited OpenZeppelin parents each carry their own ERC-7201
///      namespace, with no overlap. Identical to `ParkToken` v1.0.0.
///
///      **Self-transfer policy** — there is no admin mint, so the v1.0.0
///      `mint(address(this))` foot-gun no longer exists. User-side
///      `transfer(address(this), …)` is NOT blocked: this matches every
///      mainstream ERC-20 (USDC, USDT, PYUSD). Holders sending tokens to the
///      proxy by mistake bear that risk; documenting here so the policy is
///      explicit.
///
///      **Initialization** — `initialize(InitConfig)` is retained for source
///      completeness but is NOT callable on the live proxy (its `initializer`
///      slot was consumed by the v1.0.0 init). The upgrade is performed with
///      empty call data (`upgradeToAndCall(newImpl, "")`).
///
///      Storage-layout safety vs the deployed v1.0.0 is verified by a
///      `forge inspect storage-layout` diff (identical) and, at deploy time,
///      by the OZ Upgrades validator with `ParkToken` passed as the
///      upgrade-from reference programmatically (the equivalent NatSpec
///      upgrade-from tag is intentionally not used here).
contract ParkTokenV1_1 is
    Initializable,
    ERC20Upgradeable,
    ERC20BurnableUpgradeable,
    ERC20PermitUpgradeable,
    ERC20CappedUpgradeable,
    AccessControlDefaultAdminRulesUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ============================ Constants ============================

    uint8 private constant TOKEN_DECIMALS = 6;
    uint256 public constant INITIAL_SUPPLY = 1_000_000_000 * 10 ** TOKEN_DECIMALS;

    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant RESCUER_ROLE = keccak256("RESCUER_ROLE");
    /// @notice Admin role for UPGRADER_ROLE. Self-administered so
    ///         DEFAULT_ADMIN cannot escalate to it. Granted only to the
    ///         Timelock at init.
    bytes32 public constant TIMELOCK_ADMIN_ROLE = keccak256("TIMELOCK_ADMIN_ROLE");

    /// @dev keccak256(abi.encode(uint256(keccak256("earnpark.storage.ParkToken.Metadata")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant METADATA_STORAGE_LOCATION =
        0x2c6f79634877d4fe165c547185a8e0ef04f5e43f93083c43ee2d9f6afee57d00;

    uint48 private constant MIN_ADMIN_DELAY = 24 hours;
    uint48 private constant MAX_ADMIN_DELAY = 30 days;

    // ============================ Storage ==============================

    /// @custom:storage-location erc7201:earnpark.storage.ParkToken.Metadata
    struct MetadataStorage {
        string contractURI;
    }

    // ============================ Errors ===============================

    error ZeroDefaultAdmin();
    error ZeroUpgrader();
    error ZeroRescuer();
    error ZeroInitialHolder();
    error InitialHolderIsSelf();
    error AdminDelayTooShort(uint48 provided, uint48 min);
    error AdminDelayTooLong(uint48 provided, uint48 max);
    error DuplicateRoleAssignment(address account);
    error EmptyContractURI();
    error UpgraderNotContract(address upgrader);
    error CannotRenounceTimelockAdminRole();
    error CannotRevokeTimelockAdminRole();

    error CannotRescueSelf();
    error RescueRecipientIsSelf();
    error ZeroRescueToken();
    error ZeroRescueRecipient();
    error ZeroRescueAmount();
    error EthTransferFailed();
    error InsufficientEthBalance(uint256 requested, uint256 available);

    // ============================ Events ===============================

    event RescuedERC20(address indexed token, address indexed to, uint256 amount, address indexed operator);
    event RescuedETH(address indexed to, uint256 amount, address indexed operator);
    event ContractURIUpdated(string previousURI, string newURI, address indexed operator);

    // ============================ Init =================================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice v1.0.0 init config, retained for source completeness. NOT
    ///         callable on the live proxy (initializer slot already consumed).
    struct InitConfig {
        address defaultAdmin;
        uint48 defaultAdminTransferDelay;
        address upgrader;
        address rescuer;
        address initialHolder;
        string initialContractURI;
    }

    /// @notice One-shot initializer (historical — consumed by v1.0.0). Mints
    ///         INITIAL_SUPPLY to initialHolder, configures cap, grants roles
    ///         with UPGRADER hardened admin, sets initial metadata.
    /// @param config See InitConfig field comments.
    function initialize(InitConfig calldata config) external initializer {
        _validateInitConfig(config);

        __ERC20_init("PARK Token", "PARK");
        __ERC20Burnable_init();
        __ERC20Permit_init("PARK Token");
        __ERC20Capped_init(INITIAL_SUPPLY);
        __AccessControlDefaultAdminRules_init(config.defaultAdminTransferDelay, config.defaultAdmin);

        // Harden UPGRADER_ROLE admin → TIMELOCK_ADMIN_ROLE (self-administered).
        // DEFAULT_ADMIN cannot grant itself UPGRADER nor TIMELOCK_ADMIN.
        _setRoleAdmin(TIMELOCK_ADMIN_ROLE, TIMELOCK_ADMIN_ROLE);
        _setRoleAdmin(UPGRADER_ROLE, TIMELOCK_ADMIN_ROLE);
        _grantRole(TIMELOCK_ADMIN_ROLE, config.upgrader);
        _grantRole(UPGRADER_ROLE, config.upgrader);

        _grantRole(RESCUER_ROLE, config.rescuer);

        _getMetadataStorage().contractURI = config.initialContractURI;
        // previousURI is "" — metadata has never been set before init.
        emit ContractURIUpdated("", config.initialContractURI, msg.sender);

        _mint(config.initialHolder, INITIAL_SUPPLY);
    }

    function _validateInitConfig(InitConfig calldata c) private view {
        if (c.defaultAdmin == address(0)) revert ZeroDefaultAdmin();
        if (c.upgrader == address(0)) revert ZeroUpgrader();
        if (c.rescuer == address(0)) revert ZeroRescuer();
        if (c.initialHolder == address(0)) revert ZeroInitialHolder();
        if (c.initialHolder == address(this)) revert InitialHolderIsSelf();
        if (c.defaultAdminTransferDelay < MIN_ADMIN_DELAY) {
            revert AdminDelayTooShort(c.defaultAdminTransferDelay, MIN_ADMIN_DELAY);
        }
        if (c.defaultAdminTransferDelay > MAX_ADMIN_DELAY) {
            revert AdminDelayTooLong(c.defaultAdminTransferDelay, MAX_ADMIN_DELAY);
        }
        if (bytes(c.initialContractURI).length == 0) revert EmptyContractURI();
        if (c.upgrader.code.length == 0) revert UpgraderNotContract(c.upgrader);
        if (c.defaultAdmin == c.upgrader) revert DuplicateRoleAssignment(c.upgrader);
        if (c.defaultAdmin == c.rescuer) revert DuplicateRoleAssignment(c.rescuer);
        if (c.upgrader == c.rescuer) revert DuplicateRoleAssignment(c.upgrader);
    }

    // ============================ Admin delay ==========================

    /// @notice Overrides OZ to enforce the same MIN/MAX bounds post-init.
    /// @dev Access control is enforced by `super.changeDefaultAdminDelay`,
    ///      which is `onlyRole(DEFAULT_ADMIN_ROLE)` inside OZ.
    function changeDefaultAdminDelay(uint48 newDelay) public virtual override {
        if (newDelay < MIN_ADMIN_DELAY) revert AdminDelayTooShort(newDelay, MIN_ADMIN_DELAY);
        if (newDelay > MAX_ADMIN_DELAY) revert AdminDelayTooLong(newDelay, MAX_ADMIN_DELAY);
        super.changeDefaultAdminDelay(newDelay);
    }

    // ============================ Renounce guard =======================

    /// @notice Blocks renouncement of `TIMELOCK_ADMIN_ROLE` to prevent the
    ///         self-administered role from being permanently dropped — that
    ///         would lock the contract out of any future UUPS upgrade.
    /// @param role Role to renounce.
    /// @param callerConfirmation Must equal `msg.sender` per OZ semantics.
    function renounceRole(bytes32 role, address callerConfirmation)
        public
        virtual
        override(AccessControlDefaultAdminRulesUpgradeable)
    {
        if (role == TIMELOCK_ADMIN_ROLE) revert CannotRenounceTimelockAdminRole();
        super.renounceRole(role, callerConfirmation);
    }

    /// @notice Blocks **self-revocation** of `TIMELOCK_ADMIN_ROLE`. Allows a
    ///         different holder to revoke a retired one (Timelock-rotation).
    /// @param role Role to revoke.
    /// @param account Holder to remove.
    function revokeRole(bytes32 role, address account)
        public
        virtual
        override(AccessControlDefaultAdminRulesUpgradeable)
    {
        if (role == TIMELOCK_ADMIN_ROLE && account == _msgSender()) {
            revert CannotRevokeTimelockAdminRole();
        }
        super.revokeRole(role, account);
    }

    // ============================ Rescue ===============================

    /// @notice Rescue foreign ERC-20 tokens stuck on this contract.
    /// @param token ERC-20 to sweep. Must be non-zero and not this contract.
    /// @param to Recipient. Must be non-zero and not this contract.
    /// @param amount Units to transfer. Must be non-zero.
    function rescueERC20(IERC20 token, address to, uint256 amount) external onlyRole(RESCUER_ROLE) {
        if (address(token) == address(0)) revert ZeroRescueToken();
        if (address(token) == address(this)) revert CannotRescueSelf();
        if (to == address(this)) revert RescueRecipientIsSelf();
        if (to == address(0)) revert ZeroRescueRecipient();
        if (amount == 0) revert ZeroRescueAmount();
        token.safeTransfer(to, amount);
        emit RescuedERC20(address(token), to, amount, msg.sender);
    }

    /// @notice Rescue ETH stuck on this contract.
    /// @param to Recipient. Must be non-zero and not this contract.
    /// @param amount Wei to transfer. Must be non-zero and ≤ contract balance.
    /// @dev Slither suppressions:
    ///        - `arbitrary-send-eth`: recipient parameter is RESCUER_ROLE-gated.
    ///        - `reentrancy-events`: event emitted after call is intentional.
    function rescueETH(address to, uint256 amount) external onlyRole(RESCUER_ROLE) {
        if (to == address(this)) revert RescueRecipientIsSelf();
        if (to == address(0)) revert ZeroRescueRecipient();
        if (amount == 0) revert ZeroRescueAmount();
        uint256 balance = address(this).balance;
        if (amount > balance) revert InsufficientEthBalance(amount, balance);
        // slither-disable-next-line arbitrary-send-eth
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert EthTransferFailed();
        // slither-disable-next-line reentrancy-events
        emit RescuedETH(to, amount, msg.sender);
    }

    // ============================ Metadata =============================

    /// @notice Returns the contract metadata URI (OpenSea / CoinGecko).
    /// @return Current metadata URI string.
    function contractURI() external view returns (string memory) {
        return _getMetadataStorage().contractURI;
    }

    /// @notice Update the contract metadata URI.
    /// @param newURI Non-empty URI.
    function setContractURI(string calldata newURI) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bytes(newURI).length == 0) revert EmptyContractURI();
        MetadataStorage storage $ = _getMetadataStorage();
        string memory previousURI = $.contractURI;
        $.contractURI = newURI;
        emit ContractURIUpdated(previousURI, newURI, msg.sender);
    }

    // ============================ Version ==============================

    /// @notice On-chain identifier for the live implementation. v1.1.0 is the
    ///         mint-removed Stage 1 upgrade.
    function implVersion() public pure virtual returns (string memory) {
        return "v1.1.0";
    }

    // ============================ Cap ==================================

    /// @notice Supply cap at 1B PARK. Returned via `pure` override so the
    ///         value is a compile-time constant in this implementation's
    ///         bytecode — no storage read, no setter, no run-time mutation.
    /// @dev The `openzeppelin.storage.ERC20Capped._cap` slot was written at
    ///      v1.0.0 init but is never read because of this `pure` override.
    ///      Any successor that DROPS the `pure` override must verify the
    ///      stored `_cap` before relying on it.
    function cap() public pure override returns (uint256) {
        return INITIAL_SUPPLY;
    }

    // ============================ Internals ============================

    function _getMetadataStorage() private pure returns (MetadataStorage storage $) {
        assembly {
            $.slot := METADATA_STORAGE_LOCATION
        }
    }

    // ============================ Overrides ============================

    /// @dev C3-linearized override chain:
    ///        ERC20Capped (cap enforcement on mint) → ERC20 (balance mutation).
    /// @param from Source address (zero for mint).
    /// @param to Destination (zero for burn).
    /// @param value Units to move.
    function _update(address from, address to, uint256 value)
        internal
        virtual
        override(ERC20Upgradeable, ERC20CappedUpgradeable)
    {
        super._update(from, to, value);
    }

    /// @notice UUPS upgrade authorization. UPGRADER_ROLE-gated. The upgrade
    ///         path remains OPEN in v1.1.0 — it is frozen in the terminal
    ///         Stage 2 implementation.
    /// @param newImplementation Address of the new implementation contract.
    function _authorizeUpgrade(address newImplementation) internal virtual override onlyRole(UPGRADER_ROLE) {}

    /// @notice PARK token uses 6 decimals.
    /// @return Always 6.
    function decimals() public pure virtual override returns (uint8) {
        return TOKEN_DECIMALS;
    }

    /// @notice EIP-165 interface support.
    /// @param interfaceId EIP-165 ID.
    /// @return True iff the interface is supported by AccessControl.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(AccessControlDefaultAdminRulesUpgradeable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
