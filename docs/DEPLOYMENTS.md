# PARK Token — Deployments

Canonical production deployment addresses for PARK Token. Verify every address
against BscScan / Sourcify before integrating.

## BNB Smart Chain (chainId 56) — PRODUCTION v1.0.0

| Component | Address |
|---|---|
| **PARK Token (proxy)** | [`0xbc6829B26f0Bed03239E016ff11009c188844a8E`](https://bscscan.com/address/0xbc6829B26f0Bed03239E016ff11009c188844a8E) |
| Implementation (`ParkToken`) | [`0xa3efcaeb1b882a4d874c5003a284967c3405462f`](https://bscscan.com/address/0xa3efcaeb1b882a4d874c5003a284967c3405462f) |
| Timelock (`ParkTimelockController`, 48h minDelay) | [`0x64113a560c17c699aaf30d6d953af22c2c3bd05a`](https://bscscan.com/address/0x64113a560c17c699aaf30d6d953af22c2c3bd05a) |

**Token parameters**

| Field | Value |
|---|---|
| Name / Symbol | PARK Token / PARK |
| Decimals | **6** (non-standard — scale raw amounts by 10^6, not 10^18) |
| Total supply / cap | 1,000,000,000 PARK (fixed cap; burn-and-reissue model, never exceeds cap) |
| Standard | ERC-20 + ERC-2612 (permit) + capped + UUPS (ERC-1822) |
| Proxy pattern | ERC-1967 via ZeframLou CREATE3 factory `0x6aA3D87e99286946161dCA02B97C5806fC5eD46F` |
| Salt | `keccak256("earnpark.parktoken.production.v1.proxy")` = `0x254ebb2bc1f56bd48ad3e36bc84029801f26da7cf0da0862279fa96710ebf884` |

## Governance (Gnosis Safe)

| Safe | Address | Role |
|---|---|---|
| Admin | [`0xBE26469075864F48806dE7be55Fa12b5f9a00f78`](https://bscscan.com/address/0xBE26469075864F48806dE7be55Fa12b5f9a00f78) | `DEFAULT_ADMIN_ROLE` (mint to cap, metadata, rescuer admin) + Timelock `PROPOSER_ROLE` |
| Treasury | [`0x92feF557FB7E0DED9F22Fa0B2A41a7D991888042`](https://bscscan.com/address/0x92feF557FB7E0DED9F22Fa0B2A41a7D991888042) | holds the initial 1B PARK supply |
| Guardian | [`0xd060C2c2693cf07A7D74604CbcB390bf61dA485b`](https://bscscan.com/address/0xd060C2c2693cf07A7D74604CbcB390bf61dA485b) | Timelock `CANCELLER_ROLE` (emergency cancel of scheduled upgrades) |
| Rescuer | [`0x0574c14AADb0185Afe257B147dD2Ec258D912BB1`](https://bscscan.com/address/0x0574c14AADb0185Afe257B147dD2Ec258D912BB1) | `RESCUER_ROLE` (recover non-PARK ERC-20 / native asset sent by mistake; cannot touch PARK) |
| Vesting | [`0xAeF5e817e5696E2f2ac2447b12AbD779A784F0d5`](https://bscscan.com/address/0xAeF5e817e5696E2f2ac2447b12AbD779A784F0d5) | no contract role — operational custody for the vesting layer (Sablier streams + platform distribution); ordinary token holder |

UUPS upgrades are gated by the Timelock (`UPGRADER_ROLE`) with a 48-hour delay;
the Admin Safe proposes and the Guardian Safe can cancel within the window.
`TIMELOCK_ADMIN_ROLE` is self-administered by the Timelock — `DEFAULT_ADMIN`
cannot grant itself upgrade authority.

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
