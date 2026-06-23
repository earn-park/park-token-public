# Audit scope

## In scope

| File | Purpose |
|---|---|
| `contracts/ParkToken.sol` | Main token contract — full audit |
| `contracts/ParkTokenV1_1.sol` | Stage 1 MEXC upgrade — removes `mint()` while preserving storage and UUPS |
| `contracts/ParkTokenV1_2.sol` | Stage 2 MEXC upgrade — adds `PAUSER_ROLE` + `pause`/`unpause` only; no mint/freeze/blocklist/wipe |
| `contracts/ParkTokenV2.sol` | Stage 3 MEXC upgrade (TERMINAL) — public `upgradeToAndCall` reverts `UpgradeabilityRenounced()` (selector `0x54c0b5e6`) → upgradeability permanently renounced; no new storage, no reinitializer; v1.2 surface retained |
| `contracts/imports/TimelockControllerImport.sol` | Wrapper around OZ TimelockController v5.6.1 (thin subclass with no added logic — forwards constructor args verbatim) |
| `contracts/imports/ERC1967ProxyImport.sol` | Wrapper around OZ ERC1967Proxy v5.6.1 (thin subclass with no added logic — forwards constructor args verbatim) |
| `scripts/deploy/base/deploy-bsc.ts` | Deploy pipeline — operational review (correctness of post-deploy assertions, no role-leak) |
| `scripts/deploy/base/create3-factory.ts` | CREATE3 factory bindings — operational review |

## Trusted dependencies (out of scope)

| Dependency | Trust basis |
|---|---|
| OpenZeppelin v5.6.1 (capped, burnable, permit, AccessControl, UUPSUpgradeable) | Independently audited library; vendored in `lib/` |
| Solady CREATE3 minimal-proxy initcode | Canonical 16-byte constant, not a lib import |
| ZeframLou CREATE3 Factory at `0x6aA3D87e99286946161dCA02B97C5806fC5eD46F` | Deployed via Nick's-method (keyless) on BSC + Arbitrum + Eth + 50+ EVM chains; same address everywhere; bytecode hash verified at runtime by `verifyExtcodehash()` |

## Out of scope

- Vendored OpenZeppelin / forge-std libs in `lib/` — use upstream audits
- ZeframLou CREATE3 Factory source — use upstream community audits
- BscScan source verification process

## Dependency pins

| Path | Version | Vendored at SHA | Notes |
|---|---|---|---|
| `lib/openzeppelin-contracts` | v5.6.1 | `9cfdccd35350f7bcc585cf2ede08cd04e7f0ec10` | Vendored at the commit SHA above. Auditor should verify the imported files (ERC20Upgradeable, AccessControl, UUPS, ERC20PermitUpgradeable) are functionally identical to v5.6.1 by diffing the relevant subset. |
| `lib/openzeppelin-contracts-upgradeable` | v5.6.1 | `25780dbcea4d5124fd517f002f0f8984881c5198` | Same as above. |
| `lib/forge-std` | v1.15.0 | `0844d7e1fc5e60d77b68e469bff60265f236c398` | exact tag |

Bytecode reproducibility: rebuild from these exact dep versions + the
compiler invariants below MUST produce the same deployed bytecode.
Any auditor-side mismatch indicates supply-chain drift — investigate.
See `docs/BYTECODE-BASELINE.md` for the expected keccak256 hashes.

**Known low-severity advisories.** `npm audit` reports low-severity issues in
dev-only transitive dependencies of the deploy toolchain; no upstream fix
available. None affect deployed bytecode. The `audit-level=moderate` setting
in `.npmrc` keeps these from blocking install.

## Toolchain layout

- **Foundry (`forge`)** — primary compiler for tests, security tooling
  (`forge build`, `forge test`, `slither`), and the audit-anchor bytecode
  baseline. Foundry hashes are the canonical reference.
- **Hardhat (`hardhat`)** — used for **deploy artefact production** — the
  deploy script `scripts/deploy/base/deploy-bsc.ts` consumes Hardhat
  artifacts from `artifacts/` (populated by `npx hardhat compile`). All
  on-chain calls in the runtime path use pure viem — `hardhat-ethers` is
  declared as a devDependency only because it is a transitive peer of
  Hardhat 3 plugins, but no runtime script imports `ethers` from the
  audit-scope perspective.

For audit purposes, **both Foundry and Hardhat artifact families are
baselined** in `docs/BYTECODE-BASELINE.md`. Same Solidity source produces
divergent metadata bytes between toolchains (compiler-injected metadata
hash differs), so the file lists six rows — Foundry + Hardhat for each of
`ParkToken`, `ParkERC1967Proxy`, `ParkTimelockController`, and every production
upgrade implementation such as `ParkTokenV1_1` / `ParkTokenV1_2` / `ParkTokenV2`.
`scripts/repro.sh` asserts every row and exits non-zero on any drift. Do not
submit an exchange/audit packet until that version's rows are present. The
Foundry rows for the upgrade impls are CI-Linux values (Foundry bakes the
absolute source path into the metadata trailer — see `docs/BYTECODE-BASELINE.md`);
the Hardhat rows are environment-independent.

## Compiler invariants

- Solidity 0.8.34
- evm version: cancun
- via_ir: true
- optimizer: enabled, runs=10000
- Foundry: `forge Version 1.5.1-stable, Commit SHA: b0a9dd9ceda36f63e2326ce530c10e6916f4b8a2, Build Timestamp: 2025-12-22` — pin via `foundryup --version b0a9dd9ceda36f63e2326ce530c10e6916f4b8a2` for reproducibility

These MUST be preserved by the auditor's reproduction build (otherwise bytecode hashes diverge).

## Test suite

Expected: **86 Foundry tests** (78 unit + 8 invariant), 0 failures, 0 skipped.
TS unit tests: **34**.

Run via: `forge test --offline -vvv` (Foundry) and
`node --import tsx --test 'scripts/**/*.test.ts'` (TS unit tests).

## What to focus on

Areas where we consider audit attention most valuable:

1. **TIMELOCK_ADMIN_ROLE self-administration** — non-standard pattern. The role admin of
   `UPGRADER_ROLE` is `TIMELOCK_ADMIN_ROLE`, which is its own admin. Verify this isolates
   `DEFAULT_ADMIN_ROLE` from upgrade authority and that the renounce/self-revoke guards
   make role bricking unreachable.

2. **`revokeRole` asymmetry** — self-revoke of `TIMELOCK_ADMIN_ROLE` is blocked, but
   cross-revoke (one holder revoking another) is allowed. See `docs/UPGRADE-HAZARDS.md` H-2 for
   the rationale (rotation flow). Verify the asymmetry doesn't open an unintended escalation.

3. **CREATE3 trust chain** — proxy is deployed via `ZeframLou` factory at
   `0x6aA3D87e99286946161dCA02B97C5806fC5eD46F`. Verify the runtime extcodehash check in
   `scripts/deploy/base/create3-factory.ts` is sufficient against substitution.

4. **`rescueETH` reentrancy** — uses `.call{value:...}` to send ETH. Verify the `success`
   check + event emission ordering doesn't allow reentrancy-events suppression.

5. **EIP-7702 delegated-EOA bypass on `UpgraderNotContract`** — the init-time check
   `c.upgrader.code.length > 0` cannot detect EIP-7702 delegated EOAs (post-Pectra). See
   `docs/UPGRADE-HAZARDS.md` H-3. Verify the operator-action mitigation is sufficient.

6. **ERC-7201 namespace + `cap()` pure override** — H-1 in `docs/UPGRADE-HAZARDS.md` describes
   the carry-forward obligation. Verify a future implementation that drops the `pure` override
   does not silently corrupt cap reads.

7. **V1.2 pauser reinitializer** — verify `reinitializePauser(address)` is
   callable only through Timelock/`UPGRADER_ROLE`, rejects zero address,
   grants exactly one approved pauser Safe, and cannot be claimed by an
   arbitrary caller after an empty-data upgrade.

8. **V2 terminal renounce (`ParkTokenV2`)** — verify the renounce is total and
   correct: overriding only the public `upgradeToAndCall` to revert
   `UpgradeabilityRenounced()` is sufficient because it is the sole public upgrade
   entrypoint in OZ v5 (`upgradeTo` removed) and `_authorizeUpgrade` /
   `_upgradeToAndCallUUPS` have no other caller — so the ERC-1967 impl slot can
   never be rewritten. `_authorizeUpgrade` is deliberately left inherited
   (overriding it would emit an unreachable-code warning in the vendored base and
   adds no security). Verify no other path (proxiableUUID, initializer re-entry,
   delegatecall) can set the slot, and that pause/roles/burn/permit/rescue/metadata
   still work post-renounce. **Naming waiver:** the custom error
   `UpgradeabilityRenounced()` is intentionally un-prefixed to match the entire
   public lineage (`ZeroPauser`, `ZeroUpgrader`, … — none `Park`-prefixed);
   renaming would also change the selector that the on-chain renounce proof pins.
