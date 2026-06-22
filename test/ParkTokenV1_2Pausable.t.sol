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

/// @notice Pausable step: `ParkToken` v1.0.0 proxy upgraded to `ParkTokenV1_2`
///         (no mint + pause). Asserts state preservation, mint gone, pause
///         works, AND that the proxy stays UUPS-upgradeable (a further upgrade
///         still succeeds — upgradeability is NOT frozen in this step).
contract ParkTokenV1_2PausableTest is Test {
    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    uint256 internal constant EXPECTED_INITIAL_SUPPLY = 1_000_000_000 * 10 ** 6;
    uint48 internal constant ADMIN_DELAY = 48 hours;
    bytes32 internal constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 internal constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    ParkToken internal token;
    ParkTokenV1_2 internal v12;
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
        v12 = ParkTokenV1_2(address(token));
    }

    function _upgradeToV1_2() internal {
        address newImpl = address(new ParkTokenV1_2());
        vm.prank(address(timelock));
        UUPSUpgradeable(address(token))
            .upgradeToAndCall(newImpl, abi.encodeCall(ParkTokenV1_2.reinitializePauser, (guardian)));
    }

    function _upgradeToV1_2EmptyData() internal {
        address newImpl = address(new ParkTokenV1_2());
        vm.prank(address(timelock));
        UUPSUpgradeable(address(token)).upgradeToAndCall(newImpl, "");
    }

    function _implOf() internal view returns (address) {
        return address(uint160(uint256(vm.load(address(token), IMPL_SLOT))));
    }

    function _mintCallSucceeds() internal returns (bool ok) {
        (ok,) = address(token).call(abi.encodeWithSignature("mint(address,uint256)", holder, uint256(1)));
    }

    function test_upgrade_state_noMint_pauserGranted() public {
        uint256 supplyBefore = token.totalSupply();
        uint256 adminBalBefore = token.balanceOf(admin);

        _upgradeToV1_2();

        assertEq(token.implVersion(), "v1.2.0");
        assertEq(token.totalSupply(), supplyBefore);
        assertEq(token.balanceOf(admin), adminBalBefore);
        assertEq(token.cap(), EXPECTED_INITIAL_SUPPLY);
        assertFalse(_mintCallSucceeds(), "mint must be gone");
        assertTrue(token.hasRole(PAUSER_ROLE, guardian), "pauser granted");
    }

    function test_pause_blocksTransfers_thenUnpause() public {
        vm.prank(admin);
        assertTrue(token.transfer(holder, 1_000 * 10 ** 6));
        _upgradeToV1_2();

        vm.prank(guardian);
        v12.pause();

        vm.prank(holder);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        token.transfer(admin, 1);

        vm.prank(holder);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        token.burn(1);

        vm.prank(guardian);
        v12.unpause();

        vm.prank(holder);
        assertTrue(token.transfer(admin, 1));
    }

    function test_pause_onlyPauser() public {
        _upgradeToV1_2();
        vm.prank(admin); // DEFAULT_ADMIN is not the pauser
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, PAUSER_ROLE)
        );
        v12.pause();
    }

    function test_admin_rotatesPauser_and_setsMetadata() public {
        _upgradeToV1_2();
        address newPauser = makeAddr("newPauser");
        vm.startPrank(admin);
        token.grantRole(PAUSER_ROLE, newPauser);
        token.revokeRole(PAUSER_ROLE, guardian);
        token.setContractURI("https://earnpark.com/metadata-v1_2.json");
        vm.stopPrank();
        assertTrue(token.hasRole(PAUSER_ROLE, newPauser));
        assertFalse(token.hasRole(PAUSER_ROLE, guardian));
        assertEq(token.contractURI(), "https://earnpark.com/metadata-v1_2.json");
    }

    /// @notice The whole point of this step: upgradeability is RETAINED.
    function test_stillUpgradeable_afterPauseStep() public {
        _upgradeToV1_2();
        address implB = address(new ParkTokenV1_2());
        vm.prank(address(timelock));
        UUPSUpgradeable(address(token)).upgradeToAndCall(implB, ""); // must NOT revert
        assertEq(_implOf(), implB, "proxy did not adopt the new impl");
        assertEq(token.implVersion(), "v1.2.0");
    }

    function test_reinitializePauser_cannotRunTwice() public {
        _upgradeToV1_2();
        vm.expectRevert();
        v12.reinitializePauser(holder);
    }

    function test_emptyDataUpgrade_blocksOutsiderReinitialize() public {
        _upgradeToV1_2EmptyData();

        vm.prank(outsider);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, outsider, UPGRADER_ROLE)
        );
        v12.reinitializePauser(outsider);

        assertFalse(token.hasRole(PAUSER_ROLE, outsider));
    }
}
