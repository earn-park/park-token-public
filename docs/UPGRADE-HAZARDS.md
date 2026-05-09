# Upgrade hazards

Forward-compatibility obligations that every successor implementation deployed via UUPS
upgrade MUST respect. Auditors should re-check these on every upgrade.

---

## H-1. ERC20Capped storage slot

`__ERC20Capped_init(INITIAL_SUPPLY)` writes the `_cap` value into the OZ ERC-7201
namespace `openzeppelin.storage.ERC20Capped` at deploy. The current `cap()` is a `pure`
override that ignores this slot.

**Any successor implementation that drops the `pure` override** will resume reading the
slot, which still contains the original `INITIAL_SUPPLY` (no migration needed for that
case). However, if the slot is ever re-purposed for something else, the cap reading will
silently return junk.

**Operator action on every upgrade:** confirm `cap()` either (a) remains a `pure` override
returning a constant, OR (b) explicitly verifies `super.cap() == expected` in the new
implementation.

---

## H-2. Renounce / self-revoke guards on `TIMELOCK_ADMIN_ROLE`

`renounceRole` is blocked for `TIMELOCK_ADMIN_ROLE` outright. `revokeRole` is blocked
**only when the caller revokes themselves** (`account == _msgSender()`). The asymmetry is
deliberate:

- A single compromised holder must not be able to brick the role (covered by both guards).
- A legitimate Timelock-rotation flow must remain feasible: governance grants
  `TIMELOCK_ADMIN_ROLE` to the new holder, then the new holder revokes the retired holder.
  That second step uses a different `msg.sender` and is therefore allowed.

**A future implementation that drops these overrides** would re-enable the simple brick
path (single holder renounces or self-revokes → `UPGRADER_ROLE` becomes ungrantable
forever).

**Operator action on every upgrade:** keep both `renounceRole` and `revokeRole` overrides;
keep tests `test_renounceRole_blocksTimelockAdminRole`,
`test_revokeRole_blocksSelfRevocationOfTimelockAdminRole`, and
`test_revokeRole_allowsTimelockAdminRotation` green.

---

## H-3. EIP-7702 delegated-EOA bypass on `UpgraderNotContract`

`_validateInitConfig` checks `c.upgrader.code.length == 0` to reject EOAs as upgrader.
Post-Pectra (EIP-7702), an EIP-7702 delegated EOA reports `code.length > 0` even
though it is not a deployed contract. The check cannot detect this class of
misconfiguration on its own.

**Operator action:** every deploy MUST verify the upgrader address resolves to a
`TimelockController`-shaped runtime (call `getMinDelay()` and confirm it returns a sane
value).

---

## H-4. ERC-7201 namespace registry

Adding any new namespaced struct in a future implementation requires:

1. Computing the slot via the canonical formula:
   `keccak256(abi.encode(uint256(keccak256(NAME)) - 1)) & ~bytes32(uint256(0xff))`
2. Asserting the slot does NOT collide with `earnpark.storage.ParkToken.Metadata` or any
   `openzeppelin.storage.*` parent namespace (see `docs/STORAGE-LAYOUT.md`).
3. Adding a `test_<namespace>NamespaceSlot_matchesERC7201` regression test.

The OZ Hardhat-Upgrades plugin `validations.json` flags layout deltas at deploy time but
does NOT check namespace collisions across non-inheritance ranges. Manual review required.
