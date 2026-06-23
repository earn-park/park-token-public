# PARK Token — Deployments

Canonical production deployment addresses for PARK Token. Verify every address
against BscScan / Sourcify before integrating.

## BNB Smart Chain (chainId 56) — PRODUCTION v2.0.0 (TERMINAL — upgradeability renounced)

| Component | Address |
|---|---|
| **PARK Token (proxy)** | [`0xbc6829B26f0Bed03239E016ff11009c188844a8E`](https://bscscan.com/address/0xbc6829B26f0Bed03239E016ff11009c188844a8E) |
| Implementation (`ParkTokenV2`, **terminal**) | [`0x56bf859C87113067327A9B2953C060ea5D0B2e5F`](https://bscscan.com/address/0x56bf859C87113067327A9B2953C060ea5D0B2e5F) |
| Previous implementation (`ParkTokenV1_2` v1.2.0) | [`0x59c0E0d4B4Ea85CdA57a8E524aEd1D429f8831eE`](https://bscscan.com/address/0x59c0E0d4B4Ea85CdA57a8E524aEd1D429f8831eE) |
| Timelock (`ParkTimelockController`) | [`0x64113a560c17c699aaf30d6d953af22c2c3bd05a`](https://bscscan.com/address/0x64113a560c17c699aaf30d6d953af22c2c3bd05a) — retains no upgrade power (impl renounced) |

**Token parameters**

| Field | Value |
|---|---|
| Name / Symbol | PARK Token / PARK |
| Decimals | **6** (non-standard — scale raw amounts by 10^6, not 10^18) |
| Total supply / cap | 1,000,000,000 PARK cap; `mint()` removed in v1.1, so supply is strictly non-increasing after genesis |
| Standard | ERC-20 + ERC-2612 (permit) + capped + burnable + pausable; UUPS (ERC-1822) **upgradeability permanently renounced** in v2.0.0 (`upgradeToAndCall` reverts `UpgradeabilityRenounced()`, selector `0x54c0b5e6`) |
| Proxy pattern | ERC-1967 via ZeframLou CREATE3 factory `0x6aA3D87e99286946161dCA02B97C5806fC5eD46F` |
| Salt | `keccak256("earnpark.parktoken.production.v1.proxy")` = `0x254ebb2bc1f56bd48ad3e36bc84029801f26da7cf0da0862279fa96710ebf884` |

## Governance (Gnosis Safe)

| Safe | Address | Role |
|---|---|---|
| Admin | [`0xBE26469075864F48806dE7be55Fa12b5f9a00f78`](https://bscscan.com/address/0xBE26469075864F48806dE7be55Fa12b5f9a00f78) | `DEFAULT_ADMIN_ROLE` (metadata, rescuer admin, pauser rotation after v1.2; no mint since v1.1) + Timelock `PROPOSER_ROLE` |
| Treasury | [`0x92feF557FB7E0DED9F22Fa0B2A41a7D991888042`](https://bscscan.com/address/0x92feF557FB7E0DED9F22Fa0B2A41a7D991888042) | holds the initial 1B PARK supply |
| Guardian | [`0xd060C2c2693cf07A7D74604CbcB390bf61dA485b`](https://bscscan.com/address/0xd060C2c2693cf07A7D74604CbcB390bf61dA485b) | Timelock `CANCELLER_ROLE` (emergency cancel of scheduled upgrades) + `PAUSER_ROLE` (`pause()` / `unpause()` since v1.2; threshold being raised to multisig) |
| Rescuer | [`0x0574c14AADb0185Afe257B147dD2Ec258D912BB1`](https://bscscan.com/address/0x0574c14AADb0185Afe257B147dD2Ec258D912BB1) | `RESCUER_ROLE` (recover non-PARK ERC-20 / native asset sent by mistake; cannot touch PARK) |
| Vesting | [`0xAeF5e817e5696E2f2ac2447b12AbD779A784F0d5`](https://bscscan.com/address/0xAeF5e817e5696E2f2ac2447b12AbD779A784F0d5) | no contract role — operational custody for the vesting layer (Sablier streams + platform distribution); ordinary token holder |

**Upgradeability is permanently renounced (v2.0.0, 2026-06-23).** The proxy's
`upgradeToAndCall` reverts `UpgradeabilityRenounced()` — no implementation can
ever replace `ParkTokenV2`. The Timelock still holds `UPGRADER_ROLE` as an inert
artifact, but there is no reachable path to rewrite the ERC-1967 implementation
slot. AccessControl is unaffected: `DEFAULT_ADMIN` can still rotate
`PAUSER_ROLE` / `RESCUER_ROLE` and set metadata.

**v2.0.0 (live):** terminal. No `mint` (since v1.1), `pause` / `unpause` under
`PAUSER_ROLE` (since v1.2), upgradeability renounced (v2.0.0). No
freeze/blocklist, no wipe/admin force-burn, no supply-increasing path.

**Executed governance actions**

- **2026-06-15** — Timelock `CANCELLER_ROLE` rotated to the **Guardian Safe** and revoked
  from the Admin Safe, completing the proposer/canceller separation (Guardian is now the
  sole emergency canceller). Execute txs:
  grant [`0x2c5fdeb0…dfd8`](https://bscscan.com/tx/0x2c5fdeb00b2da6adc1cbba27fb4ec054f6581103372c5723122447591bc4dfd8),
  revoke [`0x4a7595c4…e692`](https://bscscan.com/tx/0x4a7595c47081c76c0d5767ddf8968023af5078861a8db9399b06d2d59d8ae692).
- **2026-06-15** — Governance Safes raised from bootstrap 1/1 to **multisig**: **Admin,
  Treasury, Rescuer, and Vesting are 3/5** on BSC, and the **Admin Safe is also 3/5** on
  Arbitrum and Ethereum (same address). The Guardian Safe's multisig is being finalised.
  Co-signer addresses are managed internally.
- **2026-06-22** — Timelock `minDelay` reduced **48h → 15m** (`updateDelay(900)`)
  for the MEXC remediation window. Execute tx
  [`0x2007e169…51072`](https://bscscan.com/tx/0x2007e169a850decef7618c9cce3474d83270cd1129d661239336ef4603c51072).
- **2026-06-22** — Stage 1 MEXC upgrade executed: proxy implementation moved to
  `ParkTokenV1_1` at `0x885C40D264B31487d56d5391b74BCced48a9ba0A`; `mint()` is
  absent and supply is strictly non-increasing after genesis. Execute tx
  [`0x5810191a…a1c9`](https://bscscan.com/tx/0x5810191af17eed2592181b95d1a0136df40b349750ead19a06940a4dd503a1c9).
- **2026-06-22** — Stage 2 MEXC upgrade executed: proxy implementation moved to
  `ParkTokenV1_2` at `0x59c0E0d4B4Ea85CdA57a8E524aEd1D429f8831eE`; adds
  `PAUSER_ROLE` + `pause()` / `unpause()` (held by the Guardian Safe), `mint`
  still absent, supply/cap unchanged. Schedule Safe tx `0x035e0582…f094ff` (3/3);
  execute tx
  [`0xf068b84a…7292e`](https://bscscan.com/tx/0xf068b84ad430f55a9aaa82edae71ed8cc110add1cb12b0980626858f5c77292e).
- **2026-06-23** — Stage 3 MEXC upgrade executed (TERMINAL): proxy implementation
  moved to `ParkTokenV2` at `0x56bf859C87113067327A9B2953C060ea5D0B2e5F`;
  **UUPS upgradeability permanently renounced** (`upgradeToAndCall` reverts
  `UpgradeabilityRenounced()`, selector `0x54c0b5e6`). No reinitializer (empty
  data); `mint` absent, pause retained, supply/cap unchanged. Schedule Safe tx
  `0xe9282c99…2ae1` (3/3); execute tx
  [`0xf8abdf05…32e0`](https://bscscan.com/tx/0xf8abdf059c8256de887c7e5d590aaf8a2bd1a7ee9c0307a85879a9d3cce332e0).
  Satisfies the MEXC listing requirement to renounce upgradeability.

## Audit

CertiK security assessment, final report **2026-05-29** — 0 Critical / 0 Major
(4 Resolved, 3 Acknowledged). See [`docs/AUDIT-RESPONSE.md`](AUDIT-RESPONSE.md)
for the per-finding disposition.

## Verifying the address yourself

The proxy address is a pure function of `(factory, deployer, salt)` via CREATE3
(the proxy creation code is **not** an input). Recompute it from
`scripts/deploy/base/create3-factory.ts` `computeProxyAddress(...)` with the
factory address above, deployer `0x86a784334cC09168De69511E69E699E52E097d66`,
and `PARK_TOKEN_SALT`; it must equal the proxy address listed here.

The deployed proxy runtime bytecode keccak256 matches the audited
`ParkERC1967Proxy` baseline in [`docs/BYTECODE-BASELINE.md`](BYTECODE-BASELINE.md)
exactly (the proxy has no immutables).
