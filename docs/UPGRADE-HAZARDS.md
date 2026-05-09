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

---

## H-5. Explorer mark-as-proxy must be re-run on every upgrade

The Etherscan V2 `verifyproxycontract` API call (documented in
`docs/DEPLOY-MECHANIC.md` §«Mark-as-proxy on the explorer») registers
the implementation pointer that the explorer uses to render the
«Read as Proxy» / «Write as Proxy» tabs. The registration is keyed to a
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
  «Read Contract» panels) will silently call into the wrong fragment if
  the storage layout changed.

**Operator action on every UUPS upgrade:**

1. After `Timelock.execute(...)` lands, source-verify the new impl with
   `npx hardhat verify --network <bsc|...> <newImplAddress>`.
2. Re-issue the `verifyproxycontract` API call for each chain on which
   the proxy is live, passing the NEW impl address as
   `expectedimplementation`. Recipe in `docs/DEPLOY-MECHANIC.md`.
3. Confirm in a browser that the «Read as Proxy» / «Write as Proxy»
   tabs render the new impl's ABI before signalling «upgrade complete»
   to downstream integrations.

**Scope reminder:** this is operational hygiene, not a contract
invariant. The on-chain proxy state is correct after `execute(...)` —
the explorer is the only thing that needs re-pointing.
