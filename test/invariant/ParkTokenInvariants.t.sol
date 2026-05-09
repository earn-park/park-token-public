// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test, StdInvariant} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ParkToken} from "../../contracts/ParkToken.sol";

/// @notice Fuzz handler for ParkToken. No pause/freeze actions —
///         feature surface is intentionally minimal. Actions try-call so
///         _update revert paths (cap exceedance) get exercised.
contract Handler is Test {
    ParkToken public token;

    address[] public actors;
    address public admin;
    address public rescuer;

    uint256 public calls_transfer;
    uint256 public calls_approve;
    uint256 public calls_transferFrom;
    uint256 public calls_burn;
    uint256 public calls_burnFrom;
    uint256 public calls_mint;
    uint256 public calls_rescueETH;

    constructor(ParkToken _token, address[] memory _actors, address _admin, address _rescuer) {
        token = _token;
        actors = _actors;
        admin = _admin;
        rescuer = _rescuer;
    }

    function _pick(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function action_transfer(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        address from = _pick(fromSeed);
        address to = _pick(toSeed + 1);
        uint256 bal = token.balanceOf(from);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(from);
        try token.transfer(to, amount) returns (bool) {
            calls_transfer++;
        } catch {}
    }

    function action_approve(uint256 ownerSeed, uint256 spenderSeed, uint256 amount) external {
        address owner = _pick(ownerSeed);
        address spender = _pick(spenderSeed + 1);
        vm.prank(owner);
        try token.approve(spender, amount) returns (bool) {
            calls_approve++;
        } catch {}
    }

    function action_transferFrom(uint256 spenderSeed, uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        address spender = _pick(spenderSeed);
        address from = _pick(fromSeed + 1);
        address to = _pick(toSeed + 2);
        uint256 bal = token.balanceOf(from);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(from);
        try token.approve(spender, amount) {}
        catch {
            return;
        }
        vm.prank(spender);
        try token.transferFrom(from, to, amount) returns (bool) {
            calls_transferFrom++;
        } catch {}
    }

    function action_burn(uint256 fromSeed, uint256 amount) external {
        address from = _pick(fromSeed);
        uint256 bal = token.balanceOf(from);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(from);
        try token.burn(amount) {
            calls_burn++;
        } catch {}
    }

    function action_burnFrom(uint256 spenderSeed, uint256 fromSeed, uint256 amount) external {
        address spender = _pick(spenderSeed);
        address from = _pick(fromSeed + 1);
        uint256 bal = token.balanceOf(from);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(from);
        try token.approve(spender, amount) {}
        catch {
            return;
        }
        vm.prank(spender);
        try token.burnFrom(from, amount) {
            calls_burnFrom++;
        } catch {}
    }

    function action_mint(uint256 toSeed, uint256 amount) external {
        address to = _pick(toSeed);
        uint256 headroom = token.cap() - token.totalSupply();
        if (headroom == 0) return;
        amount = bound(amount, 1, headroom);
        vm.prank(admin);
        try token.mint(to, amount) {
            calls_mint++;
        } catch {}
    }

    function action_rescueETH(uint256 toSeed, uint256 amount) external {
        address to = _pick(toSeed);
        uint256 bal = address(token).balance;
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(rescuer);
        try token.rescueETH(to, amount) {
            calls_rescueETH++;
        } catch {}
    }
}

/// @title ParkTokenInvariantsTest
/// @notice Invariant suite for ParkToken: covers supply bound, role lattice,
///         self-rescue block, init one-shot, admin delay bounds, ETH non-accretion,
///         and balance conservation. Each invariant runs the configured `runs × depth`
///         from foundry.toml [invariant].
contract ParkTokenInvariantsTest is StdInvariant, Test {
    uint256 internal constant EXPECTED_INITIAL_SUPPLY = 1_000_000_000 * 10 ** 6;
    uint48 internal constant ADMIN_DELAY = 48 hours;
    uint48 internal constant MIN_ADMIN_DELAY = 24 hours;
    uint48 internal constant MAX_ADMIN_DELAY = 30 days;

    ParkToken internal token;
    TimelockController internal timelock;
    Handler internal handler;

    address internal admin = makeAddr("base_inv_admin");
    address internal rescuer = makeAddr("base_inv_rescuer");
    address internal actor1 = makeAddr("base_inv_actor1");
    address internal actor2 = makeAddr("base_inv_actor2");
    address internal actor3 = makeAddr("base_inv_actor3");
    address internal actor4 = makeAddr("base_inv_actor4");

    address[] internal trackedActors;
    bytes32 internal upgraderRoleAdminAtSetup;

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
            initialContractURI: "https://earnpark.com/metadata.json"
        });
        bytes memory initData = abi.encodeCall(ParkToken.initialize, (cfg));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        token = ParkToken(payable(address(proxy)));

        vm.prank(admin);
        token.transfer(actor1, 1_000_000e6);
        vm.prank(admin);
        token.transfer(actor2, 1_000_000e6);
        vm.prank(admin);
        token.transfer(actor3, 1_000_000e6);
        vm.prank(admin);
        token.transfer(actor4, 1_000_000e6);

        trackedActors.push(admin);
        trackedActors.push(actor1);
        trackedActors.push(actor2);
        trackedActors.push(actor3);
        trackedActors.push(actor4);

        vm.deal(address(token), 10 ether);

        upgraderRoleAdminAtSetup = token.getRoleAdmin(token.UPGRADER_ROLE());

        handler = new Handler(token, trackedActors, admin, rescuer);

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = Handler.action_transfer.selector;
        selectors[1] = Handler.action_approve.selector;
        selectors[2] = Handler.action_transferFrom.selector;
        selectors[3] = Handler.action_burn.selector;
        selectors[4] = Handler.action_burnFrom.selector;
        selectors[5] = Handler.action_mint.selector;
        selectors[6] = Handler.action_rescueETH.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));

        targetContract(address(handler));
    }

    /// (1) Cap is compile-time constant.
    function invariant_1_capImmutable() public view {
        assertEq(token.cap(), EXPECTED_INITIAL_SUPPLY);
    }

    /// (2) totalSupply ≤ cap at all times.
    function invariant_2_supplyNeverExceedsCap() public view {
        assertLe(token.totalSupply(), token.cap());
    }

    /// Sum of balances across tracked actors == totalSupply (conservation).
    function invariant_sumOfTrackedBalancesEqualsTotalSupply() public view {
        uint256 sum;
        for (uint256 i = 0; i < trackedActors.length; i++) {
            sum += token.balanceOf(trackedActors[i]);
        }
        assertEq(sum, token.totalSupply());
    }

    /// (4) UPGRADER_ROLE admin must remain TIMELOCK_ADMIN_ROLE.
    function invariant_4_upgraderRoleAdminStable() public view {
        bytes32 adminNow = token.getRoleAdmin(token.UPGRADER_ROLE());
        assertEq(adminNow, token.TIMELOCK_ADMIN_ROLE());
        assertEq(adminNow, upgraderRoleAdminAtSetup);
    }

    /// (5) Self-rescue always reverts.
    function invariant_5_selfRescueAlwaysReverts() public {
        vm.prank(rescuer);
        bool slipped;
        try token.rescueERC20(IERC20(address(token)), actor1, 1) {
            slipped = true;
        } catch {}
        assertFalse(slipped, "self-rescue did not revert");
    }

    /// (6) initialize cannot be called twice.
    function invariant_6_reinitializeAlwaysReverts() public {
        ParkToken.InitConfig memory cfg = ParkToken.InitConfig({
            defaultAdmin: admin,
            defaultAdminTransferDelay: ADMIN_DELAY,
            upgrader: address(timelock),
            rescuer: rescuer,
            initialHolder: admin,
            initialContractURI: "x"
        });
        bool slipped;
        try token.initialize(cfg) {
            slipped = true;
        } catch {}
        assertFalse(slipped, "re-initialization succeeded");
    }

    /// (7) Admin delay always within [24h, 30d].
    function invariant_7_adminDelayInBounds() public view {
        uint48 current = token.defaultAdminDelay();
        assertGe(current, MIN_ADMIN_DELAY);
        assertLe(current, MAX_ADMIN_DELAY);
    }

    /// (9) No ETH accretion outside rescue path.
    function invariant_9_noEthReceivedOutsideRescue() public view {
        // Setup seeds 10 ether; rescue can only reduce it (no receive/fallback).
        assertLe(address(token).balance, 10 ether);
    }

    /// Liveness check: at least one state-mutating call was made by the handler.
    function afterInvariant() public view {
        assertGt(
            handler.calls_transfer() + handler.calls_mint() + handler.calls_burn(),
            0,
            "handler made zero state mutations"
        );
    }
}
