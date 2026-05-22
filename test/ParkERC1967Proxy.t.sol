// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import {ParkToken} from "../contracts/ParkToken.sol";
import {ParkERC1967Proxy} from "../contracts/imports/ERC1967ProxyImport.sol";

/// @notice EAA-02 constructor guard: ParkERC1967Proxy must be deployed with
///         init calldata that invokes ParkToken.initialize(InitConfig).
contract ParkERC1967ProxyTest is Test {
    uint48 internal constant ADMIN_DELAY = 48 hours;

    ParkToken internal impl;
    TimelockController internal timelock;

    address internal admin = makeAddr("admin");
    address internal rescuer = makeAddr("rescuer");

    function setUp() public {
        address[] memory proposers = new address[](1);
        proposers[0] = admin;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        timelock = new TimelockController(900, proposers, executors, address(0));

        impl = new ParkToken();
    }

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

    /// @dev Pins the proxy's hardcoded selector constant to the live ABI. If
    ///      InitConfig ever changes, this fails instead of a silently-wrong guard.
    function test_selectorConstant_matchesInitializeAbi() public pure {
        assertEq(ParkToken.initialize.selector, bytes4(0x14bf9d35));
    }

    /// @dev Happy path: a real initialize() call deploys and consumes the
    ///      one-shot initializer.
    function test_constructor_acceptsInitializeSelector() public {
        bytes memory data = abi.encodeCall(ParkToken.initialize, (_validConfig()));
        ParkERC1967Proxy proxy = new ParkERC1967Proxy(address(impl), data);

        ParkToken park = ParkToken(payable(address(proxy)));
        assertEq(park.name(), "PARK Token");
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        park.initialize(_validConfig());
    }

    /// @dev The EAA-02 gap OZ does NOT close: `_data` carrying a non-reverting,
    ///      non-init selector (here the `pure` decimals()). The base constructor
    ///      delegatecalls it successfully, leaving the proxy uninitialized — but
    ///      our guard reverts the whole construction.
    function test_constructor_revertsOnNonInitSelector() public {
        bytes memory data = abi.encodeWithSelector(ParkToken.decimals.selector);
        vm.expectRevert(
            abi.encodeWithSelector(
                ParkERC1967Proxy.UnexpectedInitSelector.selector, ParkToken.decimals.selector, bytes4(0x14bf9d35)
            )
        );
        new ParkERC1967Proxy(address(impl), data);
    }

    /// @dev Empty `_data` is rejected by OZ's base constructor before our guard.
    function test_constructor_revertsOnEmptyData_viaOZ() public {
        vm.expectRevert(ERC1967Proxy.ERC1967ProxyUninitialized.selector);
        new ParkERC1967Proxy(address(impl), "");
    }
}
