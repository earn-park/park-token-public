// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ParkToken} from "../contracts/ParkToken.sol";
import {ParkTokenV1_1} from "../contracts/ParkTokenV1_1.sol";

/// @notice Stage 1 upgrade test: live-shaped `ParkToken` v1.0.0 proxy upgraded
///         to `ParkTokenV1_1` (mint removed, still upgradeable). Asserts state
///         preservation, that `mint` is gone, that burn still works, and that
///         the upgrade path remains open (frozen only in Stage 2).
contract ParkTokenV1_1UpgradeTest is Test {
    uint256 internal constant EXPECTED_INITIAL_SUPPLY = 1_000_000_000 * 10 ** 6;
    uint48 internal constant ADMIN_DELAY = 48 hours;
    bytes32 internal constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    ParkToken internal token; // proxy, initialized as v1.0.0
    TimelockController internal timelock;

    address internal admin = makeAddr("admin");
    address internal rescuer = makeAddr("rescuer");
    address internal holder = makeAddr("holder");

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
        bytes memory initData = abi.encodeCall(ParkToken.initialize, (cfg));
        token = ParkToken(payable(address(new ERC1967Proxy(address(impl), initData))));
    }

    function _upgradeToV1_1() internal returns (address newImpl) {
        newImpl = address(new ParkTokenV1_1());
        // UPGRADER_ROLE is held by the Timelock; authorize as the Timelock.
        vm.prank(address(timelock));
        UUPSUpgradeable(address(token)).upgradeToAndCall(newImpl, "");
    }

    function _mintCallSucceeds() internal returns (bool ok) {
        (ok,) = address(token).call(abi.encodeWithSignature("mint(address,uint256)", holder, uint256(1)));
    }

    function test_preUpgrade_isV1_0_0_withMint() public view {
        assertEq(token.implVersion(), "v1.0.0");
    }

    function test_upgrade_bumpsVersion_preservesState_removesMint() public {
        uint256 supplyBefore = token.totalSupply();
        uint256 adminBalBefore = token.balanceOf(admin);
        uint256 capBefore = token.cap();
        string memory uriBefore = token.contractURI();

        _upgradeToV1_1();

        assertEq(token.implVersion(), "v1.1.0", "version not bumped");
        assertEq(token.totalSupply(), supplyBefore, "supply changed");
        assertEq(token.balanceOf(admin), adminBalBefore, "admin balance changed");
        assertEq(token.cap(), capBefore, "cap changed");
        assertEq(capBefore, EXPECTED_INITIAL_SUPPLY, "cap not 1B");
        assertEq(token.contractURI(), uriBefore, "metadata changed");

        // mint(address,uint256) selector no longer exists on the proxy.
        assertFalse(_mintCallSucceeds(), "mint must not exist after upgrade");
    }

    function test_afterUpgrade_burnWorks_andCannotReMint() public {
        vm.prank(admin);
        assertTrue(token.transfer(holder, 1_000 * 10 ** 6));

        _upgradeToV1_1();

        uint256 supplyBefore = token.totalSupply();
        vm.prank(holder);
        token.burn(400 * 10 ** 6);
        assertEq(token.totalSupply(), supplyBefore - 400 * 10 ** 6, "burn did not reduce supply");

        // burned supply can never be re-minted (no mint path).
        assertFalse(_mintCallSucceeds(), "mint reappeared");
    }

    function test_afterUpgrade_stillUpgradeable_andAdminMetadata() public {
        _upgradeToV1_1();

        // Upgrade path remains open (UPGRADER_ROLE intact) — frozen in Stage 2.
        assertTrue(token.hasRole(UPGRADER_ROLE, address(timelock)));

        // DEFAULT_ADMIN retains metadata authority.
        vm.prank(admin);
        token.setContractURI("https://earnpark.com/token-metadata-v1_1.json");
        assertEq(token.contractURI(), "https://earnpark.com/token-metadata-v1_1.json");
    }

    function test_upgrade_revertsForNonUpgrader() public {
        address newImpl = address(new ParkTokenV1_1());
        vm.prank(admin); // DEFAULT_ADMIN is not UPGRADER
        vm.expectRevert();
        UUPSUpgradeable(address(token)).upgradeToAndCall(newImpl, "");
    }
}
