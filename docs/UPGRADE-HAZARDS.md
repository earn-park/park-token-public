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
implementation. **MANDATORY:** every successor implementation's test file MUST carry the
EAA-07 regression tests `test_capNamespaceSlot_matchesERC7201_andInitValue`,
`test_capSlotRead_returnsInitialSupply_postUpgrade`, and
`test_capStoragePreservedAcrossUpgrade`, kept green (each tagged `EAA-07` in NatSpec,
enabling a `grep "Tag: EAA-07"` presence check in a future CI gate). They derive the
`_cap` ERC-7201 slot, cross-check it against the OZ vendored literal, assert it equals
`cap()` and `INITIAL_SUPPLY`, and prove the slot survives a UUPS upgrade — directly
exercising this hazard so a successor that resumes slot-reading is provably correct.

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

---

## H-5. Explorer mark-as-proxy must be re-run on every upgrade

The Etherscan V2 `verifyproxycontract` API call (documented in
`docs/DEPLOY-MECHANIC.md` §"Mark-as-proxy on the explorer") registers
the implementation pointer that the explorer uses to render the
"Read as Proxy" / "Write as Proxy" tabs. The registration is keyed to a
specific implementation address — it is NOT updated by an on-chain UUPS
upgrade.

Consequences if the call is skipped after an upgrade:

- The explorer continues to render the OLD implementation's ABI in the
  proxy tabs forever.
- Block-explorer-driven dashboards (DefiLlama, Tokenterminal, etc.) that
  derive function lists from the explorer-reported ABI will keep
  surfacing methods that no longer exist or omit methods that the new
  impl added.
- Wallet UIs that fetch the proxy ABI from the explorer (e.g., for
  "Read Contract" panels) will silently call into the wrong fragment if
  the storage layout changed.

**Operator action on every UUPS upgrade:**

1. After `Timelock.execute(...)` lands, source-verify the new impl with
   `npx hardhat verify --network <bsc|...> <newImplAddress>`.
2. Re-issue the `verifyproxycontract` API call for each chain on which
   the proxy is live, passing the NEW impl address as
   `expectedimplementation`. Recipe in `docs/DEPLOY-MECHANIC.md`.
3. Confirm in a browser that the "Read as Proxy" / "Write as Proxy"
   tabs render the new impl's ABI before signalling "upgrade complete"
   to downstream integrations.

**Scope reminder:** this is operational hygiene, not a contract
invariant. The on-chain proxy state is correct after `execute(...)` —
the explorer is the only thing that needs re-pointing.

---

## H-6. `DEFAULT_ADMIN_ROLE` renounce path is open by design

`renounceRole(DEFAULT_ADMIN_ROLE, account)` is reachable via OZ's
`AccessControlDefaultAdminRules.renounceRole` (which routes through the
two-step transfer flow with the configured `defaultAdminDelay`). The
`ParkToken._guard` overrides only block `TIMELOCK_ADMIN_ROLE` renounce.
Renouncing `DEFAULT_ADMIN_ROLE` permanently disables `setContractURI()`,
role-administration of `RESCUER_ROLE`, after v1.2 role-administration of
`PAUSER_ROLE`, and any future admin-gated function — the role becomes
ungrantable. Since the production v1.1 implementation removes `mint()`,
default-admin renounce is no longer the control used to prove no
burn-and-reissue path.

**Why we accept this:** the two-step transfer flow + `defaultAdminDelay`
(>= 24 h on-chain bound) gives a safety window. Removing the renounce
path entirely would also remove the legitimate "freeze admin" use case
(e.g. credibly committing to no further metadata/role administration
after launch).

**Operator action:**
- Treat `DefaultAdminTransferScheduled` to `0x0` (the renounce signal)
  as a CRITICAL alert in monitoring.
- Document any deliberate renounce in a public release note + tag the
  commit / deployment manifest before broadcasting.
- Consider blocking renounce on-chain in a future implementation if the
  product decision shifts to "admin must remain forever."

---

## H-7. Timelock `updateDelay` is unbounded

OZ `TimelockController.updateDelay()` is a self-call (the Timelock
schedules a call to itself); this contract does not set a min/max. An
adversarial proposal queue could schedule `updateDelay(0)` and execute
after the current `getMinDelay()` window, removing all timelock
protection on subsequent operations.

**Mitigation:**
- The current Timelock is the OZ contract — modifying it would require a
  new wrapper deployment + governance rotation. Out of scope for the V1
  audit.
- **Operator action:** alert on every `MinDelayChange(oldDuration, newDuration)`
  emitted by the Timelock; reject any proposal where `newDuration` is
  below the documented production target (`21600s`). The
  `ops/park-token-governance-abi.json` event subset includes
  `MinDelayChange` for monitoring tools.
- A future Timelock-wrapper deployment can enforce a `minDelay >= 21600`
  invariant at the contract level. Track in the upgrade backlog.

---

## H-8. `UPGRADER_ROLE` self-revoke is recoverable but liveness-impacting

The Timelock holds `UPGRADER_ROLE` and is itself the
`TIMELOCK_ADMIN_ROLE` admin. The `_guard` overrides allow the Timelock
to revoke its own `UPGRADER_ROLE` (no self-revoke block on this role).
If executed, all subsequent UUPS upgrades revert until
`TIMELOCK_ADMIN_ROLE` re-grants `UPGRADER_ROLE` (which itself requires
scheduling through the same Timelock — a chicken-and-egg recovery
window of `getMinDelay()`).

**Why we accept this:** the symmetric guard on `TIMELOCK_ADMIN_ROLE`
self-revoke explicitly allows `UPGRADER_ROLE` revocation (the inverse
would brick the rotation flow described in H-2 above).

**Operator action:**
- Alert on `RoleRevoked(UPGRADER_ROLE, <timelock>, <revoker>)`.
- Recovery procedure: schedule `grantRole(UPGRADER_ROLE, <timelock>)`
  via the same Timelock (proposer = Safe), wait `getMinDelay()`, execute.
  Document the incident; update audit-trail.
