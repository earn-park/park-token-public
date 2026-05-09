# Bytecode baseline (audit anchor)

These are the keccak256 hashes of `deployedBytecode.object` for each contract
in the audit scope, computed from a clean build using:

- Foundry 1.5.1-stable, commit b0a9dd9c (2025-12-22)
- Solc 0.8.34, evm cancun, optimizer runs=10000, viaIR=true
- OZ contracts vendored at SHA `9cfdccd35350f7bcc585cf2ede08cd04e7f0ec10` (v5.6.1 post-tag commit)
- OZ upgradeable vendored at SHA `25780dbcea4d5124fd517f002f0f8984881c5198` (v5.6.1 post-tag commit)
- forge-std vendored at SHA `0844d7e1fc5e60d77b68e469bff60265f236c398` (v1.15.0)

Auditor verification: run `./scripts/repro.sh` from a clean clone and compare
the printed hashes against the table below. **Any mismatch indicates supply-chain
drift — investigate before continuing.**

| Contract | deployedBytecode keccak256 |
|---|---|
| `ParkToken` | `0x01bbce7787518df25d8a571718ff271d597988585f7c43a72d918ea77ed678fe` |
| `ParkERC1967Proxy` | `0xe4e6d85c1e7d4c4248539a37bd8d2dec2b43cc196d0eec80cb369d1e0f4a852a` |
| `ParkTimelockController` | `0x0088b332b105c5785425e90b0dbb4f668463e08990ad322564f965b33d8960b7` |

If your `forge --version` SHA differs from `b0a9dd9c`, hashes WILL drift — pin
to the exact toolchain via `foundryup --version b0a9dd9ceda36f63e2326ce530c10e6916f4b8a2` for reproducibility.

If hashes match the table above, the build environment is verified and the audit
may proceed on the source code. If they differ, do not proceed — diagnose
toolchain drift first.

Each vendored library directory under `lib/` carries a `.vendored-info.txt` recording the upstream commit SHA captured at audit-handoff time. Use these to diff against the upstream repository to verify zero local modifications.
