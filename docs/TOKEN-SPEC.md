# Token specification: ParkToken (PARK)

**Contract:** `contracts/ParkToken.sol`
**Chain:** BNB Smart Chain mainnet (chainId 56)

---

## Current production upgrade line

- **v1.1 live:** `mint(address,uint256)` is removed. After genesis, supply is
  strictly non-increasing: only holder `burn` / `burnFrom` can reduce it.
- **v1.2 pending:** adds `PAUSER_ROLE`, `pause()`, and `unpause()` only. It keeps
  `mint`, freeze/blocklist, wipe/admin force-burn absent.
- **Upgradeability:** UUPS remains Timelock-gated unless a later terminal
  implementation is approved and executed.

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
- **Runtime roles plus an admin-of-admin:**
  - `DEFAULT_ADMIN_ROLE` — multisig with HW wallets (threshold per governance policy);
    sets metadata, grants/revokes `RESCUER_ROLE`, and rotates `PAUSER_ROLE` after
    v1.2. It cannot mint after v1.1 because the selector is absent.
  - `UPGRADER_ROLE` — TimelockController; authorises `upgradeToAndCall`.
  - `RESCUER_ROLE` — Safe or dedicated recovery operator; sweeps stuck ERC-20 / ETH off
    the proxy.
  - `PAUSER_ROLE` — v1.2 emergency role; can only `pause()` / `unpause()`.
  - `TIMELOCK_ADMIN_ROLE` — admin of `UPGRADER_ROLE`; granted only to the Timelock at
    init; self-administered.

### Recovery (USDC pattern)

- `rescueERC20(IERC20, address, uint256)` — recover foreign tokens stuck on the proxy.
- `rescueETH(address, uint256)` — recover stuck ETH.
- Hard invariants: `CannotRescueSelf` (token != proxy) and `RescueRecipientIsSelf`
  (recipient != proxy).

### Mint

- v1.0 exposed `mint(address,uint256)` under `DEFAULT_ADMIN_ROLE`.
- v1.1 removes `mint` entirely; no role can increase `totalSupply()` after v1.1.
- v1.2 keeps `mint` absent.

### Pause

- v1.2 adds `pause()` / `unpause()` under `PAUSER_ROLE`.
- Pause is global and reversible. It blocks token balance mutations through
  `ERC20Pausable` (`transfer`, `transferFrom`, `burn`, `burnFrom`).
- Pause does not add address-specific freeze/blocklist, wipe/admin force-burn,
  or mint/reissue authority.

### Metadata

- `contractURI()` / `setContractURI(string)` — OpenSea / CoinGecko pointer;
  `DEFAULT_ADMIN_ROLE`-gated setter.
- Non-empty URI enforced on both init and setter (`EmptyContractURI`).
- ERC-7201 namespace `earnpark.storage.ParkToken.Metadata` at slot
  `0x2c6f79634877d4fe165c547185a8e0ef04f5e43f93083c43ee2d9f6afee57d00`
  (verified by `test_metadataNamespaceSlot_matchesERC7201`).

---

## Supply semantics

**v1.0 was capped supply with admin reissuance. v1.1+ is capped supply with
strictly non-increasing post-genesis supply.**

- `INITIAL_SUPPLY = 1_000_000_000 PARK` is minted to `initialHolder` (Safe) at deploy
  via the `initialize` call.
- `totalSupply()` can never exceed `INITIAL_SUPPLY` (cap enforcement in the `_update`
  chain).
- In v1.0, `burn` / `burnFrom` reduced `totalSupply()` and `DEFAULT_ADMIN_ROLE`
  could mint back up to the cap.
- In v1.1+, `burn` / `burnFrom` reduce `totalSupply()` and no contract role can
  mint it back.
- Net effect after v1.1: the cap is a hard ceiling and supply can only stay flat
  or contract.

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
7. **Bounded ETH ingress:** the proxy has no `receive` or `fallback` payable, so naked
   `transfer()` from EOAs reverts. ETH may still enter through three privileged or
   unavoidable paths:
   - **Forced ETH:** `selfdestruct` beneficiary (post-Cancun: only same-tx selfdestruct)
     or coinbase reward — no contract guard exists at the EVM level.
   - **`upgradeToAndCall` payload:** OpenZeppelin's `ERC1967Utils.upgradeToAndCall`
     accepts `msg.value` when the setup calldata is non-empty; the value is forwarded
     to the post-upgrade `delegatecall`. Reaching this path requires `UPGRADER_ROLE`
     (Timelock-gated). Any ETH that lands at the proxy through this route is
     recoverable via `rescueETH(RESCUER_ROLE)`.
   - **Future `payable` functions added in a successor implementation:** an upgrade
     that adds payable surface would create a new ingress path. Auditors of any
     future impl MUST re-check this invariant.

   Only exit path: `rescueETH` (RESCUER_ROLE).

## Privilege matrix

Single-table view of every state-mutating function in `ParkToken.sol` plus
relevant role-administration paths. **In production, all role holders
should be Safe-mediated** (see `SECURITY.md` for governance hard gates).

| Function | Effect | Caller (role) | Bound by Timelock? | Reversible by? |
|---|---|---|---|---|
| `initialize(InitConfig)` | One-shot constructor: mints `1B PARK`, grants roles, sets URI/delays | Anyone (proxy ctor only — `_disableInitializers` on impl) | n/a | n/a |
| `pause()`, `unpause()` (v1.2+) | Halt/resume token balance mutations globally | `PAUSER_ROLE` | NO | Opposite pauser call |
| `burn(amount)`, `burnFrom(account, amount)` | Reduce `totalSupply()` by holder | Holder of tokens (or approved) | NO | Not re-mintable after v1.1 |
| `transfer`, `transferFrom`, `approve`, `permit` | Standard ERC-20 / ERC-2612; transfers blocked while paused in v1.2 | Anyone | NO | Standard ERC-20 reversibility |
| `rescueERC20(token, to, amount)` | Sweep stuck foreign ERC-20 (NOT this contract) | `RESCUER_ROLE` | NO | n/a (already moved) |
| `rescueETH(to, amount)` | Sweep stuck ETH | `RESCUER_ROLE` | NO | n/a |
| `setContractURI(string)` | Update metadata URI | `DEFAULT_ADMIN_ROLE` | NO | Subsequent `setContractURI` |
| `upgradeToAndCall(newImpl, data)` | Replace implementation slot, optionally reinit | `UPGRADER_ROLE` (Timelock-only by post-deploy invariant) | YES (`getMinDelay()` ≥ 21 600 s in prod) | Schedule reverse upgrade |
| `grantRole(role, account)` | Grant arbitrary role | Role-admin (see lattice below) | NO at contract level — Safe MUST schedule via Timelock for `UPGRADER_ROLE` | `revokeRole` |
| `revokeRole(role, account)` | Revoke role | Role-admin | NO | `grantRole` |
| `renounceRole(role, _self)` | Self-revocation | Caller | NO | NOT REVOCABLE for `TIMELOCK_ADMIN_ROLE` (blocked); irreversible for others |
| `beginDefaultAdminTransfer(newAdmin)` | Schedule admin transfer (OZ AccessControlDefaultAdminRules) | `DEFAULT_ADMIN_ROLE` | Pending state with `defaultAdminDelay` (≥ 24 h) | `cancelDefaultAdminTransfer` within window |
| `acceptDefaultAdminTransfer()` | Finalise admin transfer | Pending admin (post-delay) | n/a | Re-transfer |
| `changeDefaultAdminDelay(uint48)` | Change delay (within `[24 h, 30 d]` bounds) | `DEFAULT_ADMIN_ROLE` | Pending state with current delay | `rollbackDefaultAdminDelay` |

### Role lattice

```
DEFAULT_ADMIN_ROLE (Safe ≥3/5 prod)
├── admin of: RESCUER_ROLE (grant/revoke)
├── admin of: DEFAULT_ADMIN_ROLE (via OZ default-admin-rules 2-step + delay)
├── admin of: PAUSER_ROLE (v1.2+)
└── direct calls: setContractURI

TIMELOCK_ADMIN_ROLE (held by Timelock; self-administered)
└── admin of: UPGRADER_ROLE (only the Timelock can grant/revoke UPGRADER_ROLE)

UPGRADER_ROLE (held by Timelock)
└── direct calls: upgradeToAndCall (=> Timelock-mediated)

RESCUER_ROLE (held by RESCUER EOA / dedicated Safe)
└── direct calls: rescueERC20, rescueETH

PAUSER_ROLE (v1.2+, approved emergency Safe)
└── direct calls: pause, unpause
```

### Holder snapshot at deploy (initialize)

| Role | Holder | Notes |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | `BSC_DEFAULT_ADMIN_ADDRESS` (Safe) | Sole holder |
| `UPGRADER_ROLE` | Timelock contract | Granted at init, never directly to humans |
| `TIMELOCK_ADMIN_ROLE` | Timelock contract | Self-administered, blocks renounce |
| `RESCUER_ROLE` | `BSC_RESCUER_ADDRESS` | MUST differ from default-admin (deploy script enforces) |
| `PAUSER_ROLE` (v1.2+) | approved pauser Safe | Granted by `reinitializePauser(address)` during v1.2 upgrade |
| ERC-20 balance | `BSC_INITIAL_HOLDER` (defaults to Safe) | Holds 100 % of initial 1 B PARK supply |
