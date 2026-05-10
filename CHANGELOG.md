# Changelog

## Unreleased

### Changed (mega-review batch3)
- **L-2** — `mint()` now precomputes `amount > cap() - totalSupply()` and
  reverts with `ERC20ExceededCap(supply + amount, cap)` (canonical OZ shape,
  unchecked-wrapped for extreme inputs). Eliminates the Panic(0x11) path
  for inputs that would overflow `_update`'s checked `_totalSupply +=
  amount`. Bytecode for `ParkToken` changes:
  - new Foundry: `0x72f6be4bfca1d2b31f4c4b2f0da0dbf1e7b889bf80698198c5dc9038f7dd9dd0`
  - new Hardhat: `0x871f179d9ce0bcab930a3a9263a604ac3bf545fa26243510084bf6acba9839d2`
  - was Foundry: `0x01bbce7787518df25d8a571718ff271d597988585f7c43a72d918ea77ed678fe`
  - was Hardhat: `0x16d19ffa2817afa6662bacc108f4cf449a02cbe0851af283e8a378e8397d5305`
  - `ParkERC1967Proxy` and `ParkTimelockController` hashes unchanged.
- **H-5** — `scripts/ops/safe-exec.ts` and `scripts/ops/schedule-upgrade.ts`
  switch into "calldata-emit mode" when Safe `getThreshold() >= 2`: they
  build the SafeTx, compute the EIP-712 SafeTxHash, print both + operator
  upload instructions for Safe Wallet UI, and exit without on-chain action.
  Bootstrap (`threshold=1`) flow is unchanged. Production multisig deploys
  are now executable from the same scripts.
- **M-2** — `scripts/ops/schedule-upgrade.ts` runs an upgrade-candidate
  preflight before queueing: rejects empty bytecode at `NEW_IMPL_ADDRESS`,
  asserts `proxiableUUID() == ERC-1967 impl slot` (UUPS compatibility),
  optionally asserts `implVersion()` matches `EXPECTED_IMPL_VERSION` env,
  and rejects no-op upgrades where new impl == current impl in the
  ERC-1967 slot. Catches the «schedule, wait, revert on execute» footgun.

### Added
- **L-1** — `test_permit_revertsCrossChainReplay`: regression test that signs
  a permit at the current chainid, switches via `vm.chainId(42161)`, asserts
  `DOMAIN_SEPARATOR` rotates, and confirms the original signature reverts.
- **M-7** — `ops/park-token-governance-abi.json`: separate ABI subset
  containing role/upgrade/Timelock events + read-only governance query
  functions, for monitoring tools (Tenderly Alerts, Forta, The Graph).
  Distinct from `ops/210-base-abi.json` (deploy-time slim ABI).
- **M-4 / M-5 / L-4** — `docs/UPGRADE-HAZARDS.md` adds H-6 (DEFAULT_ADMIN
  renounce as accepted-by-design), H-7 (Timelock `updateDelay` unbounded —
  monitor `MinDelayChange`), H-8 (UPGRADER_ROLE self-revoke recoverable —
  alert + recovery procedure documented).

### Changed (mega-review batch1+batch2 earlier this session)
- `implVersion()` now returns `"v1.0.0"` (was `"base-1.0.0"`). Cosmetic
  rename — drops the historical `base-` prefix carried over from the
  internal `ParkTokenBase` working name. Bytecode hash for the
  `ParkToken` implementation contract changes accordingly:
  - new `ParkToken` deployedBytecode keccak256:
    `0x01bbce7787518df25d8a571718ff271d597988585f7c43a72d918ea77ed678fe`
  - was: `0xa51d1ca5caeb55dec90723bcad06080462be89e508be79978ec053991bf60842`
  - `ParkERC1967Proxy` and `ParkTimelockController` hashes are unchanged
    (neither references `implVersion`).
- Any pre-audit on-chain instances continue to expose `implVersion() ==
  "base-1.0.0"` indefinitely; they are not load-bearing and will be
  superseded by a fresh production deploy from this updated source after
  audit completion.

## v1.0.0 — 2026-05-09 (audit-handoff snapshot)

Initial public release of the PARK Token smart-contract source for
external audit.

### Deployment posture
- Source-only release; no production deployment.
- Pre-audit rehearsals on BNB Smart Chain (chainId 56) and Arbitrum One
  (chainId 42161) used a BOOTSTRAP-config (Safe 1/1, Timelock minDelay
  900 s) — they exist for operator validation only and have no
  audit-scope significance. Specific addresses are intentionally not
  recorded here so that audit reasoning attaches to the source, not to
  any throwaway proxy.
- First production deployment will follow audit completion + production
  uplift (multi-sig Safe ≥ 3/5, Timelock minDelay 21600 s) per the
  HARD GATE policy.

### Surface
- ERC-20 (decimals 6, fixed cap 1B PARK) with ERC-2612 permit.
- UUPS upgradeable via OpenZeppelin v5.6.1 Upgradeable contracts.
- AccessControl roles: `DEFAULT_ADMIN_ROLE`, `UPGRADER_ROLE`,
  `RESCUER_ROLE`, `TIMELOCK_ADMIN_ROLE`.
- `rescueERC20`, `rescueETH` for stuck-token recovery (RESCUER role).
- ERC-7201 namespaced storage at slot
  `0x2c6f79634877d4fe165c547185a8e0ef04f5e43f93083c43ee2d9f6afee57d00`.

### Toolchain pin
- Solidity 0.8.34, viaIR=true, optimizer_runs=10000, evm cancun.
- Foundry 1.5.1-stable @ `b0a9dd9c`.
- OpenZeppelin Contracts 5.6.1, OZ Upgradeable 5.6.1, forge-std 1.15.0.
- Node 22.20.0, TypeScript 6.0.3, viem 2.48.4, Hardhat 3.4.1.

See `docs/AUDIT-SCOPE.md` and `docs/BYTECODE-BASELINE.md` for full
reproducibility instructions.
