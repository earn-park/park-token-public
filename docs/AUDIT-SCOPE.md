# Audit scope

## In scope

| File | Purpose |
|---|---|
| `contracts/ParkToken.sol` | Main token contract — full audit |
| `contracts/imports/TimelockControllerImport.sol` | Wrapper around OZ TimelockController v5.6.1 (1 line, no logic) |
| `contracts/imports/ERC1967ProxyImport.sol` | Wrapper around OZ ERC1967Proxy v5.6.1 (1 line, no logic) |
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

- **Foundry (`forge`)** is the **primary** compiler for tests, bytecode reproducibility,
  and security tooling (`forge build`, `forge test`, `slither`).
- **Hardhat (`hardhat`)** is used **only for deployment scripting** —
  `scripts/deploy/base/deploy-bsc.ts` reads compiled-artifact JSON files directly from
  the `artifacts/` directory (populated by `npx hardhat compile`). The actual deploy and
  all on-chain calls use pure viem — no `hre`, no `hardhat-ethers` runtime.

For audit purposes, only the Foundry build is authoritative. The bytecode hashes printed
by `scripts/repro.sh` are taken from `out/` (Foundry's output directory).

## Compiler invariants

- Solidity 0.8.34
- evm version: cancun
- via_ir: true
- optimizer: enabled, runs=10000
- Foundry: `forge Version 1.5.1-stable, Commit SHA: b0a9dd9ceda36f63e2326ce530c10e6916f4b8a2, Build Timestamp: 2025-12-22` — pin via `foundryup --version b0a9dd9ceda36f63e2326ce530c10e6916f4b8a2` for reproducibility

These MUST be preserved by the auditor's reproduction build (otherwise bytecode hashes diverge).

## Test suite

Expected: **85 tests** (77 unit + 8 invariant), 0 failures, 0 skipped.

Run via: `forge test --offline -vvv` (Foundry) and
`node --import tsx --test scripts/**/*.test.ts` (TS unit tests, 34 tests).

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
