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

/// @title ParkToken
/// @notice PARK — ERC-20 utility token for the EarnPark ecosystem.
///         UUPS upgradeable proxy with ERC-7201 namespaced storage,
///         AccessControlDefaultAdminRules with 2-step admin transfer,
///         USDC-style rescue paths, capped supply with admin reissuance
///         under Timelock-gated UUPS upgrades.
///
/// @dev Feature surface:
///        - ERC-20 + Burnable + Permit (EIP-2612)
///        - Capped: `cap()` returns `INITIAL_SUPPLY` via `pure` override —
///          compile-time constant in this implementation's bytecode.
///          A future UUPS upgrade can ship a different cap; that path is
///          UPGRADER_ROLE-gated (Timelock-only) — not a silent drift.
///        - AccessControlDefaultAdminRules — 2-step admin transfer with
///          24h ≤ delay ≤ 30d bounds at init AND post-init.
///        - UUPSUpgradeable — UPGRADER_ROLE admin hardened to
///          TIMELOCK_ADMIN_ROLE (self-administered) so DEFAULT_ADMIN
///          cannot grant itself upgrade rights and bypass the Timelock.
///        - Rescue ERC-20 + ETH (USDC pattern). Hard invariants
///          `CannotRescueSelf` and `RescueRecipientIsSelf`.
///        - Metadata (contractURI + DEFAULT_ADMIN-gated setter, non-empty).
///        - `implVersion()` virtual, bumpable per upgrade.
///
///      **Roles** — three runtime roles plus a self-administered
///      admin-of-admin:
///        - `DEFAULT_ADMIN_ROLE` — multisig admin (Safe with HW wallets,
///          threshold per governance policy): mints within cap, sets
///          metadata, grants/revokes `RESCUER_ROLE`.
///        - `UPGRADER_ROLE` — Timelock: authorizes UUPS upgrades.
///        - `TIMELOCK_ADMIN_ROLE` — admin of `UPGRADER_ROLE`,
///          self-administered, granted only to the Timelock.
///        - `RESCUER_ROLE` — Safe or dedicated recovery operator.
///
///      **Supply semantics** — «capped with admin reissuance», not strict
///      fixed-supply. Cap is a hard ceiling; burns reduce totalSupply;
///      DEFAULT_ADMIN can mint back up to cap. Cap itself can only be
///      changed by deploying a new implementation through the Timelock-
///      gated UUPS upgrade path.
///
///      **Storage** — single ERC-7201 namespace
///      `earnpark.storage.ParkToken.Metadata` declared in this contract;
///      the inherited OpenZeppelin parents each carry their own ERC-7201
///      namespace, with no overlap.
///
///      **Self-transfer policy** — admin-side `mint(address(this))` is
///      blocked (`CannotMintToSelf`) because the contract has no out-
///      bound transfer authority and `rescueERC20(self)` is forbidden,
///      so minted-to-self tokens would be permanently locked. User-side
///      `transfer(address(this), …)` is NOT blocked: this matches every
///      mainstream ERC-20 (USDC, USDT, PYUSD) and preserves composability
///      with routers and vaults that briefly hold balances on the token
///      address. Holders sending tokens to the proxy by mistake bear
///      that risk; documenting here so the policy is explicit.
///
///      **Initialization** — single `initialize(InitConfig)` via the
///      ERC-1967 proxy constructor. `_disableInitializers()` in the
///      implementation constructor prevents impl-direct init; the
///      `initializer` modifier sets `_initialized = 1`; any second
///      call reverts `InvalidInitialization`.
contract ParkToken is
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

    error ZeroMintAmount();
    error CannotMintToSelf();

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
    event ContractURIUpdated(string newURI);

    // ============================ Init =================================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Production init config. All addresses must be non-zero,
    ///         `upgrader` must be a contract, and `defaultAdmin`,
    ///         `upgrader`, `rescuer` must be **pairwise distinct** —
    ///         a single address holding both DEFAULT_ADMIN_ROLE and
    ///         UPGRADER_ROLE would collapse the Timelock-hardening.
    /// @dev TS / Safe-calldata bindings MUST be type-keyed by this
    ///      contract's ABI; see `scripts/deploy/base/build-bsc-calldata.ts`
    ///      for the canonical encoder.
    struct InitConfig {
        address defaultAdmin;
        uint48 defaultAdminTransferDelay;
        address upgrader;
        address rescuer;
        address initialHolder;
        string initialContractURI;
    }

    /// @notice One-shot initializer. Mints INITIAL_SUPPLY to initialHolder,
    ///         configures cap, grants roles with UPGRADER hardened admin,
    ///         sets initial metadata.
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
        emit ContractURIUpdated(config.initialContractURI);

        _mint(config.initialHolder, INITIAL_SUPPLY);
    }

    function _validateInitConfig(InitConfig calldata c) private view {
        if (c.defaultAdmin == address(0)) revert ZeroDefaultAdmin();
        if (c.upgrader == address(0)) revert ZeroUpgrader();
        if (c.rescuer == address(0)) revert ZeroRescuer();
        if (c.initialHolder == address(0)) revert ZeroInitialHolder();
        // Block initialHolder == proxy (config typo would lock the entire
        // INITIAL_SUPPLY because rescueERC20(self) reverts CannotRescueSelf).
        if (c.initialHolder == address(this)) revert InitialHolderIsSelf();
        if (c.defaultAdminTransferDelay < MIN_ADMIN_DELAY) {
            revert AdminDelayTooShort(c.defaultAdminTransferDelay, MIN_ADMIN_DELAY);
        }
        if (c.defaultAdminTransferDelay > MAX_ADMIN_DELAY) {
            revert AdminDelayTooLong(c.defaultAdminTransferDelay, MAX_ADMIN_DELAY);
        }
        if (bytes(c.initialContractURI).length == 0) revert EmptyContractURI();
        // EOA-vs-contract guard. Limitation: a Pectra-era EIP-7702 delegated
        // EOA reports `code.length > 0`, so this check cannot defeat that
        // class of misconfiguration on its own. Operators MUST verify the
        // upgrader address is a deployed TimelockController before broadcasting.
        if (c.upgrader.code.length == 0) revert UpgraderNotContract(c.upgrader);
        // Pairwise distinctness across all three specialised actors.
        // - `defaultAdmin == upgrader`: would let DEFAULT_ADMIN bypass the
        //   Timelock by holding TIMELOCK_ADMIN_ROLE / UPGRADER_ROLE itself.
        // - `defaultAdmin == rescuer`: while not a direct privilege
        //   escalation, conflating mint/metadata authority with the rescue
        //   key collapses the operational compartment that an attacker
        //   would have to compromise twice.
        // - `upgrader == rescuer`: same compartment-collapse argument; the
        //   Timelock is a contract, the rescuer is typically a Safe.
        if (c.defaultAdmin == c.upgrader) revert DuplicateRoleAssignment(c.upgrader);
        if (c.defaultAdmin == c.rescuer) revert DuplicateRoleAssignment(c.rescuer);
        if (c.upgrader == c.rescuer) revert DuplicateRoleAssignment(c.upgrader);
    }

    // ============================ Admin delay ==========================

    /// @notice Overrides OZ to enforce the same MIN/MAX bounds post-init.
    /// @dev Without this override, DEFAULT_ADMIN could schedule delay=0
    ///      and neutralise the 2-step rotation guarantee.
    ///      Access control is enforced by `super.changeDefaultAdminDelay`,
    ///      which is `onlyRole(DEFAULT_ADMIN_ROLE)` inside OZ's
    ///      `AccessControlDefaultAdminRulesUpgradeable`. We do not duplicate
    ///      the modifier here to avoid a redundant role check on every call.
    function changeDefaultAdminDelay(uint48 newDelay) public virtual override {
        if (newDelay < MIN_ADMIN_DELAY) revert AdminDelayTooShort(newDelay, MIN_ADMIN_DELAY);
        if (newDelay > MAX_ADMIN_DELAY) revert AdminDelayTooLong(newDelay, MAX_ADMIN_DELAY);
        super.changeDefaultAdminDelay(newDelay);
    }

    // ============================ Renounce guard =======================

    /// @notice Blocks renouncement of `TIMELOCK_ADMIN_ROLE` to prevent the
    ///         self-administered role from being permanently dropped — that
    ///         would lock the contract out of any future UUPS upgrade
    ///         (UPGRADER_ROLE could never be granted again).
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

    /// @notice Blocks **self-revocation** of `TIMELOCK_ADMIN_ROLE`. Pairs
    ///         with the `renounceRole` guard to close the brick path where
    ///         a `TIMELOCK_ADMIN_ROLE` holder could remove itself — but
    ///         **allows** a different holder to revoke a retired one,
    ///         enabling Timelock-rotation: grant the new holder first,
    ///         then have the new holder revoke the old. Caller-self-revoke
    ///         (`account == _msgSender()`) remains blocked because that
    ///         path could be triggered by a single compromised holder
    ///         without any second-holder check.
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

    // ============================ Mint =================================

    /// @notice Admin-gated mint up to cap. Used for **re-issuing previously
    ///         burned tokens** (the «capped with admin reissuance»
    ///         supply semantic). Initial supply is minted at deploy via
    ///         `initialize`; subsequent burns reduce `totalSupply()`, and
    ///         DEFAULT_ADMIN can re-mint back up to `cap()`. This function
    ///         CANNOT raise the cap above `INITIAL_SUPPLY` — that would
    ///         require a UUPS upgrade through the Timelock.
    /// @param to Recipient. Must be non-zero (enforced by ERC-20) and not
    ///         this contract (admin foot-gun guard — minted-to-self tokens
    ///         would be permanently locked because `rescueERC20(self)`
    ///         reverts CannotRescueSelf).
    /// @param amount Units to mint. Must be non-zero. `totalSupply() +
    ///         amount ≤ cap()` enforced via the ERC20Capped `_update` hook.
    /// @dev    Over-cap inputs revert with `ERC20ExceededCap(amount, cap)` —
    ///         the first arg is the caller-requested `amount`, NOT the
    ///         OZ-canonical `supply + amount`. We deviate so the error payload
    ///         stays well-defined for every uint256 input including pathological
    ///         values where `supply + amount` would overflow. The error
    ///         selector `ERC20ExceededCap(uint256,uint256)` and the second arg
    ///         (`cap`) are unchanged.
    function mint(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (amount == 0) revert ZeroMintAmount();
        if (to == address(this)) revert CannotMintToSelf();
        // Local cap precheck so the canonical `ERC20ExceededCap` error path is
        // the one taken even for inputs that would overflow `_update`'s checked
        // `_totalSupply += amount` arithmetic and surface as Panic(0x11) instead.
        // Subtraction `maxCap - supply` is safe under the `supply <= cap`
        // invariant (every increase routes through this gate or initialize-time
        // `_mint`). Reporting `amount` directly avoids any wrap in the error
        // payload — see the @dev tag above for the semantic deviation note.
        uint256 supply = totalSupply();
        uint256 maxCap = cap();
        if (amount > maxCap - supply) {
            revert ERC20ExceededCap(amount, maxCap);
        }
        _mint(to, amount);
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
    ///        - `arbitrary-send-eth`: recipient parameter is RESCUER_ROLE-
    ///          gated; accepted pattern.
    ///        - `reentrancy-events`: event emitted after call is intentional
    ///          (success-only semantics); no subsequent state depends on
    ///          call ordering.
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
        _getMetadataStorage().contractURI = newURI;
        emit ContractURIUpdated(newURI);
    }

    // ============================ Version ==============================

    /// @notice On-chain identifier for the live implementation. Bumped on
    ///         every impl redeploy. Virtual so upgrade impls can override.
    function implVersion() public pure virtual returns (string memory) {
        return "v1.0.0";
    }

    // ============================ Cap ==================================

    /// @notice Supply cap at 1B PARK. Returned via `pure` override so the
    ///         value is a **compile-time constant in this implementation's
    ///         bytecode** — no storage read, no setter, no run-time mutation
    ///         path reachable by any role, including DEFAULT_ADMIN.
    /// @dev Governance caveat: because the contract is UUPS-upgradeable,
    ///      a new implementation deployed via `upgradeToAndCall` CAN ship
    ///      a different `cap()` value or semantics. That path is gated by
    ///      UPGRADER_ROLE (held only by the Timelock) and therefore
    ///      subject to the Timelock's minDelay governance window — not a
    ///      silent drift.
    /// @dev Storage caveat: the `openzeppelin.storage.ERC20Capped._cap`
    ///      ERC-7201 slot is written at init by
    ///      `__ERC20Capped_init(INITIAL_SUPPLY)` but never read because
    ///      of this `pure` override. A future implementation that DROPS
    ///      the `pure` override would resume reading the (already-
    ///      populated) slot. Every successor implementation MUST either
    ///      keep the `pure` override OR explicitly verify the stored
    ///      `_cap` value before relying on it.
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

    /// @notice UUPS upgrade authorization. UPGRADER_ROLE-gated.
    /// @param newImplementation Address of the new implementation contract.
    function _authorizeUpgrade(address newImplementation) internal virtual override onlyRole(UPGRADER_ROLE) {}

    /// @notice PARK token uses 6 decimals.
    /// @return Always 6.
    function decimals() public pure virtual override returns (uint8) {
        return TOKEN_DECIMALS;
    }

    /// @notice EIP-165 interface support.
    /// @param interfaceId EIP-165 ID.
    /// @return True iff the interface is supported by AccessControl
    ///         (IAccessControl, IAccessControlDefaultAdminRules, IERC165).
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
