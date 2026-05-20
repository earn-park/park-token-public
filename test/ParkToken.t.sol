// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    IAccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/IAccessControlDefaultAdminRules.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {
    ERC20CappedUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20CappedUpgradeable.sol";
import {
    ERC20PermitUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {ParkToken} from "../contracts/ParkToken.sol";

/// @notice Test-only impl that bumps implVersion to verify upgrades work
///         and storage is preserved.
contract ParkTokenUpgradeStub is ParkToken {
    function implVersion() public pure override returns (string memory) {
        return "1.0.0-upgrade-test";
    }
}

/// @notice EAA-07 H-1 hazard simulator: reads the OZ ERC20Capped `_cap` ERC-7201
///         slot directly via assembly, mimicking what a successor implementation
///         that drops the `pure cap()` override would observe (Solidity forbids
///         widening `pure` → `view` in an override, so a real successor would
///         have to be deployed via a different inheritance graph; this stub
///         simulates that observation deterministically).
contract ParkTokenCapFromSlotStub is ParkToken {
    function capFromSlot() public view returns (uint256 stored) {
        bytes32 slot = 0x0f070392f17d5f958cc1ac31867dabecfc5c9758b4a419a200803226d7155d00;
        assembly {
            stored := sload(slot)
        }
    }

    function implVersion() public pure override returns (string memory) {
        return "1.0.0-cap-slot-reader-test";
    }
}

/// @notice Test-only ERC-20 used for rescue path coverage.
contract DummyERC20 {
    string public name = "Dummy";
    string public symbol = "DUM";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        allowance[from][msg.sender] -= value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }
}

/// @notice Recipient that reverts on receive() — used to hit
///         EthTransferFailed branch in rescueETH.
contract EthRejecter {
    receive() external payable {
        revert("nope");
    }
}

contract ParkTokenTest is Test {
    uint256 internal constant EXPECTED_INITIAL_SUPPLY = 1_000_000_000 * 10 ** 6;
    uint48 internal constant ADMIN_DELAY = 48 hours;
    uint48 internal constant MIN_ADMIN_DELAY = 24 hours;
    uint48 internal constant MAX_ADMIN_DELAY = 30 days;

    bytes32 internal constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 internal constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 internal constant TIMELOCK_ADMIN_ROLE = keccak256("TIMELOCK_ADMIN_ROLE");
    bytes32 internal constant RESCUER_ROLE = keccak256("RESCUER_ROLE");

    ParkToken internal token;
    ParkToken internal freshImpl;
    TimelockController internal timelock;

    address internal admin = makeAddr("admin");
    address internal rescuer = makeAddr("rescuer");
    address internal recipient = makeAddr("recipient");
    address internal holder = makeAddr("holder");
    address internal outsider = makeAddr("outsider");

    function setUp() public {
        address[] memory proposers = new address[](1);
        proposers[0] = admin;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        timelock = new TimelockController(900, proposers, executors, address(0));

        freshImpl = new ParkToken();
        token = ParkToken(payable(_deployProxy(_validConfig())));
    }

    // --- helpers ---

    function _validConfig() internal view returns (ParkToken.InitConfig memory) {
        return ParkToken.InitConfig({
            defaultAdmin: admin,
            defaultAdminTransferDelay: ADMIN_DELAY,
            upgrader: address(timelock),
            rescuer: rescuer,
            initialHolder: admin,
            initialContractURI: "https://earnpark.com/token-metadata.json"
        });
    }

    function _deployProxy(ParkToken.InitConfig memory cfg) internal returns (address) {
        bytes memory initData = abi.encodeCall(ParkToken.initialize, (cfg));
        return address(new ERC1967Proxy(address(freshImpl), initData));
    }

    // ============================ Init =================================

    function test_init_nameAndSymbol() public view {
        assertEq(token.name(), "PARK Token");
        assertEq(token.symbol(), "PARK");
    }

    function test_init_decimals() public view {
        assertEq(token.decimals(), 6);
    }

    function test_init_supplyAtCap() public view {
        assertEq(token.totalSupply(), EXPECTED_INITIAL_SUPPLY);
        assertEq(token.cap(), EXPECTED_INITIAL_SUPPLY);
    }

    function test_init_initialHolderReceivesFullSupply() public view {
        assertEq(token.balanceOf(admin), EXPECTED_INITIAL_SUPPLY);
    }

    function test_init_contractURI() public view {
        assertEq(token.contractURI(), "https://earnpark.com/token-metadata.json");
    }

    function test_init_implVersion() public view {
        assertEq(token.implVersion(), "v1.0.0");
    }

    function test_init_rolesGrantedCorrectly() public view {
        assertTrue(token.hasRole(DEFAULT_ADMIN_ROLE, admin));
        assertTrue(token.hasRole(UPGRADER_ROLE, address(timelock)));
        assertTrue(token.hasRole(TIMELOCK_ADMIN_ROLE, address(timelock)));
        assertTrue(token.hasRole(RESCUER_ROLE, rescuer));
    }

    function test_init_upgraderRoleAdminIsTimelockAdminRole() public view {
        assertEq(token.getRoleAdmin(UPGRADER_ROLE), TIMELOCK_ADMIN_ROLE);
    }

    function test_init_timelockAdminRoleIsSelfAdministered() public view {
        assertEq(token.getRoleAdmin(TIMELOCK_ADMIN_ROLE), TIMELOCK_ADMIN_ROLE);
    }

    function test_init_revertsZeroDefaultAdmin() public {
        ParkToken.InitConfig memory cfg = _validConfig();
        cfg.defaultAdmin = address(0);
        vm.expectRevert(ParkToken.ZeroDefaultAdmin.selector);
        _deployProxy(cfg);
    }

    function test_init_revertsZeroUpgrader() public {
        ParkToken.InitConfig memory cfg = _validConfig();
        cfg.upgrader = address(0);
        vm.expectRevert(ParkToken.ZeroUpgrader.selector);
        _deployProxy(cfg);
    }

    function test_init_revertsZeroRescuer() public {
        ParkToken.InitConfig memory cfg = _validConfig();
        cfg.rescuer = address(0);
        vm.expectRevert(ParkToken.ZeroRescuer.selector);
        _deployProxy(cfg);
    }

    function test_init_revertsZeroInitialHolder() public {
        ParkToken.InitConfig memory cfg = _validConfig();
        cfg.initialHolder = address(0);
        vm.expectRevert(ParkToken.ZeroInitialHolder.selector);
        _deployProxy(cfg);
    }

    function test_init_revertsInitialHolderIsSelf() public {
        // To reach the InitialHolderIsSelf branch we need to know the proxy
        // address before deploy. Compute it deterministically via address-
        // prediction (CREATE-based: nextNonce of `address(this)`).
        address predictedProxy = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        ParkToken.InitConfig memory cfg = _validConfig();
        cfg.initialHolder = predictedProxy;
        vm.expectRevert(ParkToken.InitialHolderIsSelf.selector);
        _deployProxy(cfg);
    }

    function test_init_revertsAdminDelayTooShort() public {
        ParkToken.InitConfig memory cfg = _validConfig();
        cfg.defaultAdminTransferDelay = uint48(MIN_ADMIN_DELAY - 1);
        vm.expectRevert(
            abi.encodeWithSelector(ParkToken.AdminDelayTooShort.selector, uint48(MIN_ADMIN_DELAY - 1), MIN_ADMIN_DELAY)
        );
        _deployProxy(cfg);
    }

    function test_init_revertsAdminDelayTooLong() public {
        ParkToken.InitConfig memory cfg = _validConfig();
        cfg.defaultAdminTransferDelay = uint48(MAX_ADMIN_DELAY + 1);
        vm.expectRevert(
            abi.encodeWithSelector(ParkToken.AdminDelayTooLong.selector, uint48(MAX_ADMIN_DELAY + 1), MAX_ADMIN_DELAY)
        );
        _deployProxy(cfg);
    }

    function test_init_revertsEmptyContractURI() public {
        ParkToken.InitConfig memory cfg = _validConfig();
        cfg.initialContractURI = "";
        vm.expectRevert(ParkToken.EmptyContractURI.selector);
        _deployProxy(cfg);
    }

    function test_init_revertsUpgraderNotContract() public {
        ParkToken.InitConfig memory cfg = _validConfig();
        address eoa = makeAddr("eoa_upgrader");
        cfg.upgrader = eoa;
        vm.expectRevert(abi.encodeWithSelector(ParkToken.UpgraderNotContract.selector, eoa));
        _deployProxy(cfg);
    }

    function test_init_revertsDuplicateRoles() public {
        ParkToken.InitConfig memory cfg = _validConfig();
        cfg.rescuer = address(timelock); // upgrader == rescuer
        vm.expectRevert(abi.encodeWithSelector(ParkToken.DuplicateRoleAssignment.selector, address(timelock)));
        _deployProxy(cfg);
    }

    function test_init_revertsDefaultAdminEqualsRescuer() public {
        // Full pairwise separation. Conflating
        // DEFAULT_ADMIN with RESCUER would collapse the operational
        // compartment that an attacker has to compromise twice (one to
        // grab admin/mint authority, one to rescue stuck tokens).
        ParkToken.InitConfig memory cfg = _validConfig();
        cfg.rescuer = admin;
        vm.expectRevert(abi.encodeWithSelector(ParkToken.DuplicateRoleAssignment.selector, admin));
        _deployProxy(cfg);
    }

    function test_init_revertsDefaultAdminEqualsUpgrader() public {
        // Pairwise-distinct check: a single Safe holding DEFAULT_ADMIN +
        // UPGRADER + TIMELOCK_ADMIN_ROLE would bypass the Timelock minDelay
        // by calling upgradeToAndCall directly. The init-time check makes
        // that misconfiguration unreachable.
        ParkToken.InitConfig memory cfg = _validConfig();
        cfg.defaultAdmin = address(timelock); // same address as upgrader
        vm.expectRevert(abi.encodeWithSelector(ParkToken.DuplicateRoleAssignment.selector, address(timelock)));
        _deployProxy(cfg);
    }

    function test_init_grantsDefaultAdminRoleAdmin() public view {
        // OZ AccessControlDefaultAdminRules makes DEFAULT_ADMIN_ROLE its own
        // admin (i.e., transfers happen via the 2-step beginDefaultAdminTransfer
        // flow, not via grantRole). Sanity check that we did not accidentally
        // change this.
        assertEq(token.getRoleAdmin(DEFAULT_ADMIN_ROLE), DEFAULT_ADMIN_ROLE);
    }

    function test_init_revertsOnSecondCall() public {
        ParkToken.InitConfig memory cfg = _validConfig();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        token.initialize(cfg);
    }

    function test_init_implCannotBeInitializedDirectly() public {
        ParkToken.InitConfig memory cfg = _validConfig();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        freshImpl.initialize(cfg);
    }

    // ============================ Mint =================================

    function test_mint_success() public {
        vm.prank(admin);
        token.burn(1_000e6);
        vm.prank(admin);
        token.mint(recipient, 1_000e6);
        assertEq(token.balanceOf(recipient), 1_000e6);
        assertEq(token.totalSupply(), EXPECTED_INITIAL_SUPPLY);
    }

    function test_mint_revertsZeroAmount() public {
        vm.prank(admin);
        vm.expectRevert(ParkToken.ZeroMintAmount.selector);
        token.mint(recipient, 0);
    }

    function test_mint_revertsWhenExceedingCap() public {
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC20CappedUpgradeable.ERC20ExceededCap.selector, EXPECTED_INITIAL_SUPPLY + 1, EXPECTED_INITIAL_SUPPLY
            )
        );
        token.mint(admin, 1);
    }

    function test_mint_revertsWithoutAdminRole() public {
        vm.prank(admin);
        token.burn(10e6);
        vm.prank(outsider);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, outsider, DEFAULT_ADMIN_ROLE
            )
        );
        token.mint(outsider, 10e6);
    }

    function test_mint_revertsToZeroAddress() public {
        vm.prank(admin);
        token.burn(10e6);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0)));
        token.mint(address(0), 10e6);
    }

    function test_mint_revertsToSelf() public {
        vm.prank(admin);
        token.burn(10e6);
        vm.prank(admin);
        vm.expectRevert(ParkToken.CannotMintToSelf.selector);
        token.mint(address(token), 10e6);
    }

    function test_transfer_toSelfIsAllowedAndPermanentlyLocks() public {
        // Explicit documentation test for the
        // intentionally-NOT-blocked user-side transfer-to-self path.
        // Mainstream ERC-20s (USDC / USDT / PYUSD) leave this open to keep
        // composability with routers/vaults that briefly hold balances on
        // the token address. Holders bear the loss-of-funds risk; admin
        // CANNOT recover (rescueERC20(self) reverts CannotRescueSelf).
        uint256 amt = 100e6;
        vm.prank(admin);
        token.transfer(holder, amt);

        vm.prank(holder);
        token.transfer(address(token), amt); // succeeds — standard ERC-20

        assertEq(token.balanceOf(holder), 0);
        assertEq(token.balanceOf(address(token)), amt);

        // Confirm there is no recovery path: rescueERC20(self) reverts.
        vm.prank(rescuer);
        vm.expectRevert(ParkToken.CannotRescueSelf.selector);
        token.rescueERC20(IERC20(address(token)), holder, amt);
    }

    // ============================ Burn =================================

    function test_burn_reducesSupply() public {
        vm.prank(admin);
        token.burn(100e6);
        assertEq(token.totalSupply(), EXPECTED_INITIAL_SUPPLY - 100e6);
        assertEq(token.balanceOf(admin), EXPECTED_INITIAL_SUPPLY - 100e6);
    }

    function test_burnFrom_consumesAllowance() public {
        vm.prank(admin);
        token.transfer(holder, 1_000e6);
        vm.prank(holder);
        token.approve(outsider, 500e6);
        vm.prank(outsider);
        token.burnFrom(holder, 500e6);
        assertEq(token.balanceOf(holder), 500e6);
        assertEq(token.allowance(holder, outsider), 0);
    }

    // ============================ Rescue ===============================

    function test_rescueERC20_success() public {
        DummyERC20 dummy = new DummyERC20();
        dummy.mint(address(token), 1_000e18);

        vm.prank(rescuer);
        vm.expectEmit(true, true, true, true, address(token));
        emit ParkToken.RescuedERC20(address(dummy), recipient, 1_000e18, rescuer);
        token.rescueERC20(IERC20(address(dummy)), recipient, 1_000e18);

        assertEq(dummy.balanceOf(recipient), 1_000e18);
    }

    function test_rescueERC20_revertsForSelfToken() public {
        vm.prank(rescuer);
        vm.expectRevert(ParkToken.CannotRescueSelf.selector);
        token.rescueERC20(IERC20(address(token)), recipient, 1);
    }

    function test_rescueERC20_revertsForSelfRecipient() public {
        DummyERC20 dummy = new DummyERC20();
        vm.prank(rescuer);
        vm.expectRevert(ParkToken.RescueRecipientIsSelf.selector);
        token.rescueERC20(IERC20(address(dummy)), address(token), 1);
    }

    function test_rescueERC20_revertsZeroToken() public {
        // Explicit ZeroRescueToken instead of relying on
        // the SafeERC20 internal revert. Improves UX and makes the
        // misconfiguration easy to identify in test traces.
        vm.prank(rescuer);
        vm.expectRevert(ParkToken.ZeroRescueToken.selector);
        token.rescueERC20(IERC20(address(0)), recipient, 1);
    }

    function test_rescueERC20_revertsZeroRecipient() public {
        DummyERC20 dummy = new DummyERC20();
        vm.prank(rescuer);
        vm.expectRevert(ParkToken.ZeroRescueRecipient.selector);
        token.rescueERC20(IERC20(address(dummy)), address(0), 1);
    }

    function test_rescueERC20_revertsZeroAmount() public {
        DummyERC20 dummy = new DummyERC20();
        vm.prank(rescuer);
        vm.expectRevert(ParkToken.ZeroRescueAmount.selector);
        token.rescueERC20(IERC20(address(dummy)), recipient, 0);
    }

    function test_rescueERC20_revertsWithoutRole() public {
        DummyERC20 dummy = new DummyERC20();
        vm.prank(outsider);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, outsider, RESCUER_ROLE)
        );
        token.rescueERC20(IERC20(address(dummy)), recipient, 1);
    }

    function test_rescueETH_success() public {
        vm.deal(address(token), 5 ether);
        vm.prank(rescuer);
        vm.expectEmit(true, false, true, true, address(token));
        emit ParkToken.RescuedETH(recipient, 3 ether, rescuer);
        token.rescueETH(recipient, 3 ether);
        assertEq(recipient.balance, 3 ether);
        assertEq(address(token).balance, 2 ether);
    }

    function test_rescueETH_revertsForSelfRecipient() public {
        vm.deal(address(token), 1 ether);
        vm.prank(rescuer);
        vm.expectRevert(ParkToken.RescueRecipientIsSelf.selector);
        token.rescueETH(address(token), 1);
    }

    function test_rescueETH_revertsZeroRecipient() public {
        vm.deal(address(token), 1 ether);
        vm.prank(rescuer);
        vm.expectRevert(ParkToken.ZeroRescueRecipient.selector);
        token.rescueETH(address(0), 1);
    }

    function test_rescueETH_revertsZeroAmount() public {
        vm.deal(address(token), 1 ether);
        vm.prank(rescuer);
        vm.expectRevert(ParkToken.ZeroRescueAmount.selector);
        token.rescueETH(recipient, 0);
    }

    function test_rescueETH_revertsInsufficient() public {
        vm.deal(address(token), 1 ether);
        vm.prank(rescuer);
        vm.expectRevert(abi.encodeWithSelector(ParkToken.InsufficientEthBalance.selector, 2 ether, 1 ether));
        token.rescueETH(recipient, 2 ether);
    }

    function test_rescueETH_revertsOnTransferFailure() public {
        EthRejecter rejecter = new EthRejecter();
        vm.deal(address(token), 1 ether);
        vm.prank(rescuer);
        vm.expectRevert(ParkToken.EthTransferFailed.selector);
        token.rescueETH(address(rejecter), 1);
    }

    function test_rescueETH_revertsWithoutRole() public {
        vm.deal(address(token), 1 ether);
        vm.prank(outsider);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, outsider, RESCUER_ROLE)
        );
        token.rescueETH(recipient, 1);
    }

    // ============================ Metadata =============================

    function test_setContractURI_success() public {
        vm.prank(admin);
        vm.expectEmit(false, false, false, true, address(token));
        emit ParkToken.ContractURIUpdated("ipfs://new-uri");
        token.setContractURI("ipfs://new-uri");
        assertEq(token.contractURI(), "ipfs://new-uri");
    }

    function test_setContractURI_revertsEmpty() public {
        vm.prank(admin);
        vm.expectRevert(ParkToken.EmptyContractURI.selector);
        token.setContractURI("");
    }

    function test_setContractURI_revertsWithoutAdminRole() public {
        vm.prank(outsider);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, outsider, DEFAULT_ADMIN_ROLE
            )
        );
        token.setContractURI("anything");
    }

    // ============================ Permit ===============================

    function test_permit_success() public {
        (address owner, uint256 pk) = makeAddrAndKey("permitOwner");
        vm.prank(admin);
        token.transfer(owner, 1_000e6);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _permitDigest(owner, recipient, 500, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        token.permit(owner, recipient, 500, deadline, v, r, s);
        assertEq(token.allowance(owner, recipient), 500);
        assertEq(token.nonces(owner), 1);
    }

    function test_permit_revertsExpired() public {
        (address owner, uint256 pk) = makeAddrAndKey("permitOwnerExp");
        uint256 deadline = block.timestamp - 1;
        bytes32 digest = _permitDigest(owner, recipient, 100, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        vm.expectRevert(abi.encodeWithSelector(ERC20PermitUpgradeable.ERC2612ExpiredSignature.selector, deadline));
        token.permit(owner, recipient, 100, deadline, v, r, s);
    }

    function test_permit_revertsReplay() public {
        (address owner, uint256 pk) = makeAddrAndKey("permitOwnerReplay");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _permitDigest(owner, recipient, 100, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        token.permit(owner, recipient, 100, deadline, v, r, s);
        // After nonce increment (now 1), the old sig — signed against nonce=0 —
        // resolves a different digest.  Recover the signer from nonce=1 digest to
        // construct the exact typed error.
        bytes32 replayDigest = _permitDigest(owner, recipient, 100, deadline);
        address replaySigner = ECDSA.recover(replayDigest, v, r, s);
        assertNotEq(replaySigner, owner, "replay signer should differ from owner");
        vm.expectRevert(
            abi.encodeWithSelector(ERC20PermitUpgradeable.ERC2612InvalidSigner.selector, replaySigner, owner)
        );
        token.permit(owner, recipient, 100, deadline, v, r, s);
    }

    function test_permit_rejectsHighSMalleableSignature() public {
        // OZ v5 ECDSA rejects high-s values — confirms ERC2612InvalidSigner is raised.
        // Flip s to its high counterpart and expect revert.
        (address owner, uint256 pk) = makeAddrAndKey("permitOwnerMalleable");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _permitDigest(owner, recipient, 100, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        // Compute the malleable counterpart: s' = secp256k1n - s; v' flips.
        bytes32 N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        bytes32 sFlipped = bytes32(uint256(N) - uint256(s));
        uint8 vFlipped = v == 27 ? 28 : 27;

        // The flipped signature is mathematically valid for the same digest
        // but OZ's ECDSA rejects it via the ECDSAInvalidSignatureS check.
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, sFlipped));
        token.permit(owner, recipient, 100, deadline, vFlipped, r, sFlipped);
    }

    /// @notice Cross-chain permit replay regression.
    ///         Confirms that DOMAIN_SEPARATOR rotates with `block.chainid`,
    ///         so a permit signature valid on chainid 56 (BSC) cannot be
    ///         replayed on chainid 42161 (Arbitrum) — even when both chains
    ///         host the same proxy address via CREATE3 + the same nonce
    ///         hasn't yet been consumed on the destination chain.
    function test_permit_revertsCrossChainReplay() public {
        (address owner, uint256 pk) = makeAddrAndKey("permitOwnerCrossChain");
        uint256 deadline = block.timestamp + 1 hours;

        // 1. Sign a permit at the current chainid (default 31337 in foundry).
        //    The signature is bound to `token.DOMAIN_SEPARATOR()`, which
        //    embeds `block.chainid` per EIP-712.
        bytes32 digestSrc = _permitDigest(owner, recipient, 100, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digestSrc);
        bytes32 domainSrc = token.DOMAIN_SEPARATOR();

        // 2. Switch to a different chainid (simulate fork to Arbitrum).
        //    OZ ERC20Permit recomputes DOMAIN_SEPARATOR lazily based on
        //    block.chainid, so this rotates the domain even though the
        //    contract address is identical.
        vm.chainId(42161);
        bytes32 domainDst = token.DOMAIN_SEPARATOR();
        assertTrue(domainSrc != domainDst, "DOMAIN_SEPARATOR must rotate with chainid");

        // 3. The original signature must now fail. ECDSA.recover yields a
        //    different signer for the rotated digest — OZ's permit then
        //    reverts with ERC2612InvalidSigner(recovered, owner). We don't
        //    pin the exact recovered address (depends on signature math), so
        //    only assert that any revert occurs and that allowance is unchanged.
        uint256 allowanceBefore = token.allowance(owner, recipient);
        vm.expectRevert();
        token.permit(owner, recipient, 100, deadline, v, r, s);
        assertEq(token.allowance(owner, recipient), allowanceBefore);

        // 4. Restore chainid for downstream tests in the same suite.
        vm.chainId(31337);
    }

    function _permitDigest(address owner, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                bytes1(0x19),
                bytes1(0x01),
                token.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                        owner,
                        spender,
                        value,
                        token.nonces(owner),
                        deadline
                    )
                )
            )
        );
    }

    // ============================ Admin delay ==========================

    function test_changeDefaultAdminDelay_acceptsValidBound() public {
        vm.prank(admin);
        token.changeDefaultAdminDelay(uint48(MIN_ADMIN_DELAY));
        // pending delay; activates after defaultAdminDelayIncreaseWait — but
        // current effective delay still in bounds.
        assertGe(token.defaultAdminDelay(), MIN_ADMIN_DELAY);
        assertLe(token.defaultAdminDelay(), MAX_ADMIN_DELAY);
    }

    function test_init_acceptsMaxAdminDelay() public {
        ParkToken.InitConfig memory cfg = _validConfig();
        cfg.defaultAdminTransferDelay = uint48(MAX_ADMIN_DELAY);
        address proxy = _deployProxy(cfg);
        assertEq(ParkToken(payable(proxy)).defaultAdminDelay(), uint48(MAX_ADMIN_DELAY));
    }

    function test_init_acceptsMinAdminDelay() public {
        ParkToken.InitConfig memory cfg = _validConfig();
        cfg.defaultAdminTransferDelay = uint48(MIN_ADMIN_DELAY);
        address proxy = _deployProxy(cfg);
        assertEq(ParkToken(payable(proxy)).defaultAdminDelay(), uint48(MIN_ADMIN_DELAY));
    }

    function test_changeDefaultAdminDelay_acceptsMaxBound() public {
        vm.prank(admin);
        // Must not revert — MAX_ADMIN_DELAY is within bounds.
        token.changeDefaultAdminDelay(uint48(MAX_ADMIN_DELAY));
        // Effective delay updates after the schedule window; current value stays in bounds.
        assertGe(token.defaultAdminDelay(), MIN_ADMIN_DELAY);
        assertLe(token.defaultAdminDelay(), MAX_ADMIN_DELAY);
        // The pending delay queue must reflect the requested new delay.
        (uint48 newDelay,) = token.pendingDefaultAdminDelay();
        assertEq(newDelay, uint48(MAX_ADMIN_DELAY));
    }

    function test_changeDefaultAdminDelay_revertsTooShort() public {
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(ParkToken.AdminDelayTooShort.selector, uint48(MIN_ADMIN_DELAY - 1), MIN_ADMIN_DELAY)
        );
        token.changeDefaultAdminDelay(uint48(MIN_ADMIN_DELAY - 1));
    }

    function test_changeDefaultAdminDelay_revertsTooLong() public {
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(ParkToken.AdminDelayTooLong.selector, uint48(MAX_ADMIN_DELAY + 1), MAX_ADMIN_DELAY)
        );
        token.changeDefaultAdminDelay(uint48(MAX_ADMIN_DELAY + 1));
    }

    function test_adminRotation_twoStepFlow() public {
        address newAdmin = makeAddr("newAdmin");
        vm.prank(admin);
        uint48 expectedSchedule = uint48(block.timestamp + ADMIN_DELAY);
        token.beginDefaultAdminTransfer(newAdmin);

        // Cannot accept before delay.
        vm.prank(newAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminDelay.selector, expectedSchedule
            )
        );
        token.acceptDefaultAdminTransfer();

        skip(ADMIN_DELAY + 1);
        vm.prank(newAdmin);
        token.acceptDefaultAdminTransfer();

        assertTrue(token.hasRole(DEFAULT_ADMIN_ROLE, newAdmin));
        assertFalse(token.hasRole(DEFAULT_ADMIN_ROLE, admin));
    }

    // ============================ UUPS upgrade =========================

    function test_upgrade_authorizedByUpgrader() public {
        ParkTokenUpgradeStub newImpl = new ParkTokenUpgradeStub();
        vm.prank(address(timelock));
        token.upgradeToAndCall(address(newImpl), "");
        assertEq(token.implVersion(), "1.0.0-upgrade-test");
    }

    function test_upgrade_revertsForDefaultAdmin() public {
        ParkTokenUpgradeStub newImpl = new ParkTokenUpgradeStub();
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, UPGRADER_ROLE)
        );
        token.upgradeToAndCall(address(newImpl), "");
    }

    function test_upgrade_revertsForOutsider() public {
        ParkTokenUpgradeStub newImpl = new ParkTokenUpgradeStub();
        vm.prank(outsider);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, outsider, UPGRADER_ROLE)
        );
        token.upgradeToAndCall(address(newImpl), "");
    }

    function test_upgrade_revertsAfterUpgraderRoleRevokedMidFlight() public {
        // Verifies upgradeToAndCall reverts if UPGRADER_ROLE is revoked between
        // proposal and execution. Path: Timelock holds TIMELOCK_ADMIN_ROLE →
        // can revoke its own UPGRADER_ROLE → subsequent upgradeToAndCall reverts.
        ParkTokenUpgradeStub newImpl = new ParkTokenUpgradeStub();
        vm.prank(address(timelock));
        token.revokeRole(UPGRADER_ROLE, address(timelock));
        assertFalse(token.hasRole(UPGRADER_ROLE, address(timelock)));

        vm.prank(address(timelock));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(timelock), UPGRADER_ROLE
            )
        );
        token.upgradeToAndCall(address(newImpl), "");
    }

    function test_defaultAdminCannotEscalateToTimelockAdmin() public {
        // DEFAULT_ADMIN cannot grant TIMELOCK_ADMIN_ROLE because admin of
        // that role is TIMELOCK_ADMIN_ROLE itself.
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, TIMELOCK_ADMIN_ROLE)
        );
        token.grantRole(TIMELOCK_ADMIN_ROLE, admin);
    }

    function test_renounceRole_blocksTimelockAdminRole() public {
        // Even the Timelock itself cannot renounce TIMELOCK_ADMIN_ROLE —
        // doing so would lock UPGRADER_ROLE forever (no one could grant
        // it again). Guard prevents the foot-gun.
        vm.prank(address(timelock));
        vm.expectRevert(ParkToken.CannotRenounceTimelockAdminRole.selector);
        token.renounceRole(TIMELOCK_ADMIN_ROLE, address(timelock));
    }

    function test_renounceRole_allowsOtherRoles() public {
        // Non-TIMELOCK_ADMIN roles renounce normally.
        vm.prank(rescuer);
        token.renounceRole(RESCUER_ROLE, rescuer);
        assertFalse(token.hasRole(RESCUER_ROLE, rescuer));
    }

    function test_revokeRole_blocksSelfRevocationOfTimelockAdminRole() public {
        // The Timelock cannot call revokeRole(TIMELOCK_ADMIN, self) because
        // a single compromised holder must not be able to brick the role.
        vm.prank(address(timelock));
        vm.expectRevert(ParkToken.CannotRevokeTimelockAdminRole.selector);
        token.revokeRole(TIMELOCK_ADMIN_ROLE, address(timelock));
    }

    function test_revokeRole_allowsTimelockAdminRotation() public {
        // Rotation flow: existing TIMELOCK_ADMIN holder grants the role to
        // a new holder, then the new holder revokes the old. Guard does
        // NOT block this path — only self-revoke is blocked.
        address newTimelock = makeAddr("rotated_timelock");
        vm.etch(newTimelock, hex"60016000f3"); // give it bytecode so future
        // operations would treat it as a contract; not strictly required here.

        vm.prank(address(timelock));
        token.grantRole(TIMELOCK_ADMIN_ROLE, newTimelock);
        assertTrue(token.hasRole(TIMELOCK_ADMIN_ROLE, newTimelock));

        // newTimelock (different account) revokes the original timelock.
        vm.prank(newTimelock);
        token.revokeRole(TIMELOCK_ADMIN_ROLE, address(timelock));
        assertFalse(token.hasRole(TIMELOCK_ADMIN_ROLE, address(timelock)));
        assertTrue(token.hasRole(TIMELOCK_ADMIN_ROLE, newTimelock));
    }

    function test_revokeRole_allowsOtherRoles() public {
        // Non-TIMELOCK_ADMIN roles revoke normally via DEFAULT_ADMIN.
        vm.prank(admin);
        token.revokeRole(RESCUER_ROLE, rescuer);
        assertFalse(token.hasRole(RESCUER_ROLE, rescuer));
    }

    function test_upgrade_preservesMetadataStorage() public {
        vm.prank(admin);
        token.setContractURI("ipfs://post-upgrade-sentinel");

        ParkTokenUpgradeStub newImpl = new ParkTokenUpgradeStub();
        vm.prank(address(timelock));
        token.upgradeToAndCall(address(newImpl), "");

        assertEq(token.contractURI(), "ipfs://post-upgrade-sentinel");
    }

    function test_upgrade_preservesPermitNonce() public {
        (address owner, uint256 pk) = makeAddrAndKey("upgradeNonceOwner");
        vm.prank(admin);
        token.transfer(owner, 1_000e6);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _permitDigest(owner, recipient, 500, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        token.permit(owner, recipient, 500, deadline, v, r, s);
        assertEq(token.nonces(owner), 1);

        ParkTokenUpgradeStub newImpl = new ParkTokenUpgradeStub();
        vm.prank(address(timelock));
        token.upgradeToAndCall(address(newImpl), "");

        assertEq(token.nonces(owner), 1);
    }

    function test_upgrade_preservesRoles() public {
        ParkTokenUpgradeStub newImpl = new ParkTokenUpgradeStub();
        vm.prank(address(timelock));
        token.upgradeToAndCall(address(newImpl), "");

        assertTrue(token.hasRole(DEFAULT_ADMIN_ROLE, admin));
        assertTrue(token.hasRole(UPGRADER_ROLE, address(timelock)));
        assertTrue(token.hasRole(RESCUER_ROLE, rescuer));
        assertEq(token.getRoleAdmin(UPGRADER_ROLE), TIMELOCK_ADMIN_ROLE);
    }

    // ============================ ERC-7201 =============================

    function test_metadataNamespaceSlot_matchesERC7201() public pure {
        bytes32 expected = keccak256(abi.encode(uint256(keccak256("earnpark.storage.ParkToken.Metadata")) - 1))
            & ~bytes32(uint256(0xff));
        assertEq(expected, 0x2c6f79634877d4fe165c547185a8e0ef04f5e43f93083c43ee2d9f6afee57d00);
    }

    /// @notice Tag: EAA-07. Asserts the OZ ERC20CappedUpgradeable `_cap` ERC-7201
    ///         slot is populated at init AND that `cap()` returns the same value.
    ///         If a successor implementation drops the `pure` override and reads
    ///         the storage slot, this test guarantees the slot already holds
    ///         INITIAL_SUPPLY so behaviour is preserved.
    /// @dev    Mandatory in every successor impl test file per docs/UPGRADE-HAZARDS H-1.
    function test_capNamespaceSlot_matchesERC7201_andInitValue() public view {
        // Derive the OZ ERC-7201 namespace slot from the documented namespace string.
        bytes32 derived =
            keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.ERC20Capped")) - 1)) & ~bytes32(uint256(0xff));
        // Cross-check against the OZ-vendored literal (catches a namespace
        // rename in a future OZ release before silent drift can occur).
        assertEq(derived, 0x0f070392f17d5f958cc1ac31867dabecfc5c9758b4a419a200803226d7155d00);
        // `ERC20CappedStorage` is a single-field struct holding `uint256 _cap`,
        // so the namespace base slot directly holds the cap as a uint256.
        uint256 stored = uint256(vm.load(address(token), derived));
        assertEq(stored, token.cap(), "_cap slot drifted from cap() override");
        assertEq(stored, EXPECTED_INITIAL_SUPPLY, "_cap slot not initialised to INITIAL_SUPPLY");
    }

    /// @notice Tag: EAA-07. Directly exercises the H-1 hazard: deploys a successor
    ///         impl that reads the `_cap` ERC-7201 slot (instead of the `pure`
    ///         constant return path), upgrades the proxy to it, and asserts the
    ///         slot read returns `EXPECTED_INITIAL_SUPPLY`. This is the load-bearing
    ///         test for EAA-07 — it proves a future implementation that resumes
    ///         slot-reading observes the value `__ERC20Capped_init` wrote at init.
    function test_capSlotRead_returnsInitialSupply_postUpgrade() public {
        ParkTokenCapFromSlotStub newImpl = new ParkTokenCapFromSlotStub();
        vm.prank(address(timelock));
        token.upgradeToAndCall(address(newImpl), "");
        ParkTokenCapFromSlotStub upgraded = ParkTokenCapFromSlotStub(address(token));
        assertEq(
            upgraded.capFromSlot(),
            EXPECTED_INITIAL_SUPPLY,
            "EAA-07: post-upgrade slot read did not return INITIAL_SUPPLY"
        );
        assertEq(token.cap(), EXPECTED_INITIAL_SUPPLY, "EAA-07: pure cap() drifted post-upgrade");
        assertEq(token.cap(), upgraded.capFromSlot(), "EAA-07: slot read and pure cap() disagree post-upgrade");
    }

    /// @notice Tag: EAA-07. Confirms the `_cap` ERC-7201 slot survives a UUPS
    ///         upgrade unchanged. Even if a successor implementation drops the
    ///         `pure cap()` override and reverts to OZ's slot-reading behaviour,
    ///         the slot still carries INITIAL_SUPPLY because no upgrade re-runs
    ///         `__ERC20Capped_init` and nothing writes the slot post-init.
    function test_capStoragePreservedAcrossUpgrade() public {
        bytes32 slot = 0x0f070392f17d5f958cc1ac31867dabecfc5c9758b4a419a200803226d7155d00;
        uint256 storedBefore = uint256(vm.load(address(token), slot));
        assertEq(storedBefore, EXPECTED_INITIAL_SUPPLY);

        ParkTokenUpgradeStub newImpl = new ParkTokenUpgradeStub();
        vm.prank(address(timelock));
        token.upgradeToAndCall(address(newImpl), "");

        uint256 storedAfter = uint256(vm.load(address(token), slot));
        assertEq(storedAfter, storedBefore, "_cap slot mutated by upgrade");
        assertEq(storedAfter, EXPECTED_INITIAL_SUPPLY, "_cap slot drifted from INITIAL_SUPPLY post-upgrade");
    }

    // ============================ Misc =================================

    function test_supportsInterface() public view {
        assertTrue(token.supportsInterface(type(IAccessControl).interfaceId));
        assertTrue(token.supportsInterface(type(IAccessControlDefaultAdminRules).interfaceId));
    }

    function testFuzz_transfer_preservesSum(uint256 amount) public {
        amount = bound(amount, 1, 1_000_000e6);
        uint256 adminBefore = token.balanceOf(admin);
        vm.prank(admin);
        token.transfer(holder, amount);
        assertEq(token.balanceOf(admin), adminBefore - amount);
        assertEq(token.balanceOf(holder), amount);
        assertEq(token.totalSupply(), EXPECTED_INITIAL_SUPPLY);
    }
}
