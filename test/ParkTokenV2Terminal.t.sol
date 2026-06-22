// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ParkToken} from "../contracts/ParkToken.sol";
import {ParkTokenV1_2} from "../contracts/ParkTokenV1_2.sol";
import {ParkTokenV2} from "../contracts/ParkTokenV2.sol";

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
}
