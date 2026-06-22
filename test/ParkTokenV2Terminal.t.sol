// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    IAccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/IAccessControlDefaultAdminRules.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ParkToken} from "../contracts/ParkToken.sol";
import {ParkTokenV1_2} from "../contracts/ParkTokenV1_2.sol";
import {ParkTokenV2} from "../contracts/ParkTokenV2.sol";

/// @notice Minimal foreign ERC-20 for rescue-path coverage on the terminal impl.
contract DummyERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}

/// @notice Terminal step: `ParkToken` v1.0.0 proxy upgraded v1.0 → v1.2 → v2.0,
///         where v2.0 permanently renounces upgradeability. Asserts the V2
///         landing is the LAST successful upgrade, every further upgrade
///         entrypoint reverts `UpgradeabilityRenounced`, and the full token
///         surface (state, pause, roles, burn, metadata) is preserved.
contract ParkTokenV2TerminalTest is Test {
    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    uint256 internal constant EXPECTED_INITIAL_SUPPLY = 1_000_000_000 * 10 ** 6;
    uint48 internal constant ADMIN_DELAY = 48 hours;
    bytes32 internal constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 internal constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    ParkToken internal token;
    ParkTokenV2 internal v2;
    TimelockController internal timelock;

    address internal admin = makeAddr("admin");
    address internal rescuer = makeAddr("rescuer");
    address internal holder = makeAddr("holder");
    address internal guardian = makeAddr("guardian");
    address internal outsider = makeAddr("outsider");

    function setUp() public {
        address[] memory proposers = new address[](1);
        proposers[0] = admin;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        timelock = new TimelockController(900, proposers, executors, address(0));

        ParkToken impl = new ParkToken();
        ParkToken.InitConfig memory cfg = ParkToken.InitConfig({
            defaultAdmin: admin,
            defaultAdminTransferDelay: ADMIN_DELAY,
            upgrader: address(timelock),
            rescuer: rescuer,
            initialHolder: admin,
            initialContractURI: "https://earnpark.com/token-metadata.json"
        });
        token =
            ParkToken(payable(address(new ERC1967Proxy(address(impl), abi.encodeCall(ParkToken.initialize, (cfg))))));
        v2 = ParkTokenV2(address(token));
    }

    /// @dev Walk the production lineage: v1.0 -> v1.2 (grant pauser) -> v2.0
    ///      (renounce). The v2.0 hop carries no reinitializer, so empty data.
    function _upgradeToV2() internal returns (address v2Impl) {
        address v12Impl = address(new ParkTokenV1_2());
        vm.prank(address(timelock));
        UUPSUpgradeable(address(token))
            .upgradeToAndCall(v12Impl, abi.encodeCall(ParkTokenV1_2.reinitializePauser, (guardian)));

        v2Impl = address(new ParkTokenV2());
        vm.prank(address(timelock));
        UUPSUpgradeable(address(token)).upgradeToAndCall(v2Impl, "");
    }

    function _implOf() internal view returns (address) {
        return address(uint160(uint256(vm.load(address(token), IMPL_SLOT))));
    }

    function _mintCallSucceeds() internal returns (bool ok) {
        (ok,) = address(token).call(abi.encodeWithSignature("mint(address,uint256)", holder, uint256(1)));
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

    function test_landingV2_isLastSuccessfulUpgrade() public {
        address v2Impl = _upgradeToV2();
        assertEq(_implOf(), v2Impl, "proxy adopted the v2 impl");
        assertEq(token.implVersion(), "v2.0.0");
    }

    function test_renounce_blocksFurtherUpgrade_emptyData() public {
        _upgradeToV2();
        address next = address(new ParkTokenV2());
        vm.prank(address(timelock)); // even the UPGRADER_ROLE holder is blocked
        vm.expectRevert(ParkTokenV2.UpgradeabilityRenounced.selector);
        UUPSUpgradeable(address(token)).upgradeToAndCall(next, "");
        assertEq(token.implVersion(), "v2.0.0", "impl unchanged");
    }

    function test_renounce_blocksFurtherUpgrade_withData() public {
        _upgradeToV2();
        address next = address(new ParkTokenV2());
        vm.prank(address(timelock));
        vm.expectRevert(ParkTokenV2.UpgradeabilityRenounced.selector);
        UUPSUpgradeable(address(token)).upgradeToAndCall(next, abi.encodeWithSignature("implVersion()"));
    }

    function test_renounce_blocksOutsiderUpgrade() public {
        _upgradeToV2();
        address next = address(new ParkTokenV2());
        vm.prank(outsider);
        vm.expectRevert(ParkTokenV2.UpgradeabilityRenounced.selector);
        UUPSUpgradeable(address(token)).upgradeToAndCall(next, "");
    }

    /// @notice Mirrors the runbook 350 Step 5 on-chain renounce proof: a
    ///         STATICCALL to `upgradeToAndCall` (it is `payable`, so this is the
    ///         no-value path the runbook's `cast call` uses) must revert with the
    ///         bare `UpgradeabilityRenounced()` selector. Pins the literal so the
    ///         runbook value (`0x54c0b5e6`) and the code can never drift.
    function test_renounce_staticcall_returnsExactSelector() public {
        address v2Impl = _upgradeToV2();
        bytes memory cd = abi.encodeWithSelector(UUPSUpgradeable.upgradeToAndCall.selector, v2Impl, bytes(""));
        (bool ok, bytes memory ret) = address(token).staticcall(cd);
        assertFalse(ok, "upgradeToAndCall must revert under STATICCALL");
        assertEq(ret.length, 4, "revert returndata is a bare custom-error selector");
        // bytes4(ret) cannot truncate: the assertion above pins ret.length == 4.
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(bytes4(ret), ParkTokenV2.UpgradeabilityRenounced.selector, "exact renounce selector");
        assertEq(ParkTokenV2.UpgradeabilityRenounced.selector, bytes4(0x54c0b5e6), "runbook 350 Step 5 literal");
    }

    function test_state_preserved_afterRenounce() public {
        uint256 supplyBefore = token.totalSupply();
        uint256 adminBalBefore = token.balanceOf(admin);

        _upgradeToV2();

        assertEq(token.implVersion(), "v2.0.0");
        assertEq(token.totalSupply(), supplyBefore);
        assertEq(token.balanceOf(admin), adminBalBefore);
        assertEq(token.cap(), EXPECTED_INITIAL_SUPPLY);
        assertEq(token.decimals(), 6);
        assertEq(token.contractURI(), "https://earnpark.com/token-metadata.json");
        assertTrue(token.hasRole(PAUSER_ROLE, guardian), "pauser preserved across the v2 hop");
    }

    function test_mint_absent_afterRenounce() public {
        _upgradeToV2();
        assertFalse(_mintCallSucceeds(), "mint must stay gone");
        assertEq(token.totalSupply(), EXPECTED_INITIAL_SUPPLY);
    }

    function test_pause_stillWorks_afterRenounce() public {
        vm.prank(admin);
        assertTrue(token.transfer(holder, 1_000 * 10 ** 6));

        _upgradeToV2();

        vm.prank(guardian);
        v2.pause();

        vm.prank(holder);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        token.transfer(admin, 1);

        vm.prank(holder);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        token.burn(1);

        vm.prank(guardian);
        v2.unpause();

        vm.prank(holder);
        assertTrue(token.transfer(admin, 1));
    }

    function test_pause_onlyPauser_afterRenounce() public {
        _upgradeToV2();
        vm.prank(admin); // DEFAULT_ADMIN is not the pauser
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, PAUSER_ROLE)
        );
        v2.pause();
    }

    /// @notice Renounce freezes the IMPLEMENTATION, not AccessControl: the admin
    ///         can still rotate `PAUSER_ROLE` (e.g. to a fixed Guardian multisig)
    ///         without any upgrade.
    function test_adminCanStillRotatePauser_afterRenounce() public {
        _upgradeToV2();
        address newPauser = makeAddr("newPauser");
        vm.startPrank(admin);
        token.grantRole(PAUSER_ROLE, newPauser);
        token.revokeRole(PAUSER_ROLE, guardian);
        vm.stopPrank();
        assertTrue(token.hasRole(PAUSER_ROLE, newPauser));
        assertFalse(token.hasRole(PAUSER_ROLE, guardian));
    }

    function test_transferAndBurn_work_afterRenounce() public {
        _upgradeToV2();
        vm.prank(admin);
        assertTrue(token.transfer(holder, 5_000 * 10 ** 6));

        uint256 supplyBefore = token.totalSupply();
        vm.prank(holder);
        token.burn(2_000 * 10 ** 6);
        assertEq(token.totalSupply(), supplyBefore - 2_000 * 10 ** 6, "burn reduces supply post-renounce");
    }

    /// @notice The allowance-spending paths route through the same paused
    ///         `_update`; a partial-effects bug would decrement the allowance
    ///         before the pause check reverts. Assert no balance, allowance, or
    ///         supply moves while paused.
    function test_transferFromAndBurnFrom_revertWhenPaused_noPartialEffects() public {
        vm.prank(admin);
        token.transfer(holder, 1_000 * 10 ** 6);
        _upgradeToV2();
        vm.prank(holder);
        token.approve(outsider, 400 * 10 ** 6);
        vm.prank(guardian);
        v2.pause();

        uint256 holderBal = token.balanceOf(holder);
        uint256 allowanceBefore = token.allowance(holder, outsider);
        uint256 supplyBefore = token.totalSupply();

        vm.prank(outsider);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        token.transferFrom(holder, outsider, 100 * 10 ** 6);
        vm.prank(outsider);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        token.burnFrom(holder, 100 * 10 ** 6);

        assertEq(token.balanceOf(holder), holderBal, "no balance moved");
        assertEq(token.allowance(holder, outsider), allowanceBefore, "allowance not spent");
        assertEq(token.totalSupply(), supplyBefore, "supply unchanged");
    }

    function test_transferFromAndBurnFrom_work_afterRenounce() public {
        vm.prank(admin);
        token.transfer(holder, 1_000 * 10 ** 6);
        _upgradeToV2();
        vm.prank(holder);
        token.approve(outsider, 600 * 10 ** 6);

        uint256 supplyBefore = token.totalSupply();
        vm.prank(outsider);
        assertTrue(token.transferFrom(holder, outsider, 200 * 10 ** 6));
        vm.prank(outsider);
        token.burnFrom(holder, 100 * 10 ** 6);

        assertEq(token.allowance(holder, outsider), 300 * 10 ** 6, "allowance spent by both paths");
        assertEq(token.totalSupply(), supplyBefore - 100 * 10 ** 6, "burnFrom reduces supply");
    }

    /// @notice ERC-2612 permit is part of the frozen-forever surface; assert a
    ///         signed permit still sets the allowance and bumps the nonce after
    ///         the terminal renounce (a regression here is unpatchable).
    function test_permit_works_afterRenounce() public {
        (address owner, uint256 pk) = makeAddrAndKey("permitOwner");
        vm.prank(admin);
        token.transfer(owner, 1_000 * 10 ** 6);
        _upgradeToV2();

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _permitDigest(owner, outsider, 500, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        token.permit(owner, outsider, 500, deadline, v, r, s);

        assertEq(token.allowance(owner, outsider), 500, "permit sets allowance post-renounce");
        assertEq(token.nonces(owner), 1, "permit bumps nonce post-renounce");
    }

    /// @notice Foreign-asset rescue stays live on the terminal impl.
    function test_rescueForeignAsset_worksAfterRenounce() public {
        _upgradeToV2();
        DummyERC20 dummy = new DummyERC20();
        dummy.mint(address(token), 1_000e18);

        vm.prank(rescuer);
        token.rescueERC20(IERC20(address(dummy)), outsider, 1_000e18);
        assertEq(dummy.balanceOf(outsider), 1_000e18, "rescuer sweeps a foreign asset post-renounce");
    }

    /// @notice The self-rescue guard (no draining PARK holder balances) survives
    ///         the freeze: rescuing the token itself still reverts.
    function test_rescueSelf_stillBlockedAfterRenounce() public {
        _upgradeToV2();
        vm.prank(rescuer);
        vm.expectRevert(ParkToken.CannotRescueSelf.selector);
        token.rescueERC20(IERC20(address(token)), outsider, 1);
    }

    /// @notice EIP-165 introspection is frozen-forever surface; assert the
    ///         supported interface ids stay true and a bogus id stays false.
    function test_supportsInterface_afterRenounce() public {
        _upgradeToV2();
        assertTrue(token.supportsInterface(type(IAccessControl).interfaceId), "IAccessControl");
        assertTrue(
            token.supportsInterface(type(IAccessControlDefaultAdminRules).interfaceId),
            "IAccessControlDefaultAdminRules"
        );
        assertTrue(token.supportsInterface(type(IERC165).interfaceId), "IERC165");
        assertFalse(token.supportsInterface(0xffffffff), "0xffffffff must be false");
    }
}
