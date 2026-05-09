# Token specification: ParkToken (PARK)

**Contract:** `contracts/ParkToken.sol`
**Chain:** BNB Smart Chain mainnet (chainId 56)

---

## Feature surface

### Token core

- ERC-20 with 6 decimals (`ERC20Upgradeable`)
- `ERC20Burnable` — holder self-burn + `burnFrom` via allowance
- `ERC20Permit` (EIP-2612) — gasless approvals
- `ERC20Capped` — cap at `INITIAL_SUPPLY = 1_000_000_000 * 10^6`. `cap()` is a `pure`
  override returning the constant — **immutable within this implementation's bytecode**
  (compile-time constant, no storage read). Future cap changes possible only via UUPS
  upgrade (UPGRADER_ROLE → Timelock minDelay window). See [Cap flexibility](#cap-flexibility).

### Access + governance

- `AccessControlDefaultAdminRulesUpgradeable` — 2-step admin transfer with
  `24h ≤ delay ≤ 30d` enforced at init **and** post-init via `changeDefaultAdminDelay`
  override.
- `UUPSUpgradeable` — `UPGRADER_ROLE` gates `_authorizeUpgrade`. The role admin is
  hardened to `TIMELOCK_ADMIN_ROLE`, which is **self-administered** so `DEFAULT_ADMIN_ROLE`
  cannot grant itself `UPGRADER_ROLE` nor escalate via `TIMELOCK_ADMIN_ROLE`.
- `renounceRole` is blocked entirely on `TIMELOCK_ADMIN_ROLE`. `revokeRole` is blocked
  only for **self-revoke** (`account == msg.sender`) to prevent the foot-gun where a
  single compromised holder drops the role and locks `UPGRADER_ROLE` forever.
  Cross-holder revoke (new holder revoking the old one) is intentionally allowed —
  rotation is via grant-new-then-revoke-old by the new holder.
- **Three runtime roles plus an admin-of-admin:**
  - `DEFAULT_ADMIN_ROLE` — multisig with HW wallets (threshold per governance policy);
    mints within cap, sets metadata, grants/revokes `RESCUER_ROLE`.
  - `UPGRADER_ROLE` — TimelockController; authorises `upgradeToAndCall`.
  - `RESCUER_ROLE` — Safe or dedicated recovery operator; sweeps stuck ERC-20 / ETH off
    the proxy.
  - `TIMELOCK_ADMIN_ROLE` — admin of `UPGRADER_ROLE`; granted only to the Timelock at
    init; self-administered.

### Recovery (USDC pattern)

- `rescueERC20(IERC20, address, uint256)` — recover foreign tokens stuck on the proxy.
- `rescueETH(address, uint256)` — recover stuck ETH.
- Hard invariants: `CannotRescueSelf` (token != proxy) and `RescueRecipientIsSelf`
  (recipient != proxy).

### Mint

- `mint(address, uint256)` under `DEFAULT_ADMIN_ROLE`.
- Cap-enforced — cannot exceed `INITIAL_SUPPLY`.
- Zero-amount reverts `ZeroMintAmount`.
- Self-recipient (`address(this)`) reverts `CannotMintToSelf`.

### Metadata

- `contractURI()` / `setContractURI(string)` — OpenSea / CoinGecko pointer;
  `DEFAULT_ADMIN_ROLE`-gated setter.
- Non-empty URI enforced on both init and setter (`EmptyContractURI`).
- ERC-7201 namespace `earnpark.storage.ParkToken.Metadata` at slot
  `0x2c6f79634877d4fe165c547185a8e0ef04f5e43f93083c43ee2d9f6afee57d00`
  (verified by `test_metadataNamespaceSlot_matchesERC7201`).

---

## Supply semantics

**"Capped supply with admin reissuance"**, not strict fixed-supply.

- `INITIAL_SUPPLY = 1_000_000_000 PARK` is minted to `initialHolder` (Safe) at deploy
  via the `initialize` call.
- `totalSupply()` can never exceed `INITIAL_SUPPLY` (cap enforcement in the `_update`
  chain).
- `burn` / `burnFrom` reduce `totalSupply()`; `DEFAULT_ADMIN_ROLE` can then `mint` back
  up to the cap.
- Net effect: the cap is a hard ceiling, not a floor. Supply can contract permanently or
  oscillate within `[0, cap]`.

---

## Cap flexibility

`cap()` is a `pure` override returning `INITIAL_SUPPLY` — **compile-time constant in this
implementation's bytecode**. No setter, no role, no run-time mutation path.

The cap is fixed at compile time via `pure cap()`. Future cap changes (bump,
storage-driven, or removal) require a UUPS upgrade through the Timelock — see
docs/UPGRADE-HAZARDS.md H-1 for the carry-forward obligations on the ERC20Capped
storage slot.

---

## Governance model

| Role | Holder | Rotation |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | multisig with HW wallets (threshold per governance policy) | 2-step timed transfer (24h-30d configurable delay, bounds enforced post-init) |
| `UPGRADER_ROLE` | TimelockController | admin = `TIMELOCK_ADMIN_ROLE`, granted only to Timelock itself |
| `TIMELOCK_ADMIN_ROLE` | TimelockController (self-admin) | `renounceRole` blocked entirely; `revokeRole` blocked only for **self-revoke** |
| `RESCUER_ROLE` | Safe or dedicated recovery operator | admin = `DEFAULT_ADMIN_ROLE` |

### Timelock minDelay policy

The `TimelockController` `minDelay` is set at deploy time via `BSC_TIMELOCK_DELAY_SECONDS`.
Production deployments use **6 hours (21600s)** to give the community time to react to
any scheduled upgrade. Bounds enforced by the deploy script: `delay >= 60s` (sanity floor).

The `defaultAdminTransferDelay` for the 2-step admin rotation is set within the `[24h, 30d]`
range enforced by the contract; production policy decision per governance.

The `.env.example` ships with `BSC_TIMELOCK_DELAY_SECONDS=900` (15 minutes) — this is a
**STAGING DEFAULT for local testing**, NOT a production value. Operators MUST override
to 21600 or higher before broadcasting to mainnet.

### Pairwise distinctness at init

`_validateInitConfig` enforces that `defaultAdmin`, `upgrader`, and `rescuer` are
**pairwise distinct**, plus `upgrader.code.length > 0` (must be a contract). A single
address holding multiple specialised roles would collapse the role lattice.

---

## Initialization

Single-shot via `initialize(InitConfig calldata)`:

```solidity
struct InitConfig {
    address defaultAdmin;
    uint48 defaultAdminTransferDelay;
    address upgrader;
    address rescuer;
    address initialHolder;
    string initialContractURI;
}
```

The implementation constructor calls `_disableInitializers()` so the impl cannot be
initialised directly. The `initialize` function uses the `initializer` modifier (sets
`_initialized = 1`); any second call reverts `InvalidInitialization`.

---

## Invariants

1. **Cap immutability (within bytecode):** `cap() == INITIAL_SUPPLY` — `pure` override.
2. **Supply bound:** `totalSupply() <= cap()`.
3. **Role isolation:** `getRoleAdmin(UPGRADER_ROLE) == TIMELOCK_ADMIN_ROLE`,
   self-administered.
4. **Self-rescue block:** `rescueERC20(address(this), ...)` reverts.
5. **Initialization one-shot:** `initialize()` uses the `initializer` modifier; a second call
   reverts `InvalidInitialization`. The implementation constructor calls `_disableInitializers()`
   to block direct initialization on the impl bytecode.
6. **Admin delay bounds:** `24h <= defaultAdminDelay <= 30d` at all times.
7. **No ETH accretion:** no `receive` or `fallback` payable; ETH only via `selfdestruct`
   beneficiary or coinbase reward; only exit via `rescueETH`.
