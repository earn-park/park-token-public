# Bytecode baseline

These are the keccak256 hashes of `deployedBytecode.object` for each contract,
computed from a clean build using:

- Foundry 1.5.1-stable, commit b0a9dd9c (2025-12-22)
- Solc 0.8.34, evm cancun, optimizer runs=10000, viaIR=true
- OZ contracts vendored at SHA `9cfdccd35350f7bcc585cf2ede08cd04e7f0ec10` (v5.6.1 post-tag commit)
- OZ upgradeable vendored at SHA `25780dbcea4d5124fd517f002f0f8984881c5198` (v5.6.1 post-tag commit)
- forge-std vendored at SHA `0844d7e1fc5e60d77b68e469bff60265f236c398` (v1.15.0)

Reproducibility check: run `./scripts/repro.sh` from a clean clone and compare
the printed hashes against the table below. **Any mismatch indicates supply-chain
drift — investigate before continuing.**

> **Note on Foundry hashes**: Foundry encodes absolute source paths into the
> compiler metadata trailer (the last ~52 bytes of the deployed bytecode), so
> Foundry-family hashes are environment-dependent. The values below are the
> CI-Linux build (`ubuntu-22.04`, repo at `/home/runner/work/park-token-public/park-token-public/`).
> Local Mac/Windows builds will diverge in the metadata trailer but the
> *runtime* bytecode (everything before the trailer) is identical. Hardhat
> normalises paths and is environment-independent.

**Two artifact families are baselined — both must match.** The deploy path
(`scripts/deploy/base/deploy-bsc.ts`) loads Hardhat artifacts; Foundry is the
canonical anchor. The same Solidity source produces different metadata bytes
between toolchains, so the Foundry and Hardhat hashes diverge intentionally.
`scripts/repro.sh` computes both and asserts each row.

| Contract | Toolchain | deployedBytecode keccak256 |
|---|---|---|
| `ParkToken` (Foundry) | foundry 1.5.1-stable | `0x2e7105f1a71b9b9c8bd6d206ac9e37b07e5dac2dfd7a413daa37de8882321e8c` |
| `ParkToken` (Hardhat) | hardhat 3.4.1 | `0xb7f7a1ba0bd5e8b22c85a6dd77aadd81d9da258a0bd12c48c2f1b78697ce601b` |
| `ParkERC1967Proxy` (Foundry) | foundry 1.5.1-stable | `0x3dd76beba31ed538a9932dcd1f80247b6a499e2c0ddf44b19a96462f8e17d0b0` |
| `ParkERC1967Proxy` (Hardhat) | hardhat 3.4.1 | `0xfa43b1689ee2ff2f373280c214e7443eda53572c882708cbfbaf239a52504ab3` |
| `ParkTimelockController` (Foundry) | foundry 1.5.1-stable | `0x3a0c9bd34c5788ccb1cf6d0bc2ba59d5f828ca21a636826199f9508cb08f2f2c` |
| `ParkTimelockController` (Hardhat) | hardhat 3.4.1 | `0xcb779433afe4d79f0e3482401f327c0546d77efb4deeef00e4bd52b4694f6cb9` |

## Upgrade implementation baselines

`ParkTokenV1_1` and `ParkTokenV1_2` are production upgrade implementations and
must be baselined before their release packets are submitted. `ParkTokenV1_2`
is not considered release-ready until this table contains both Foundry and
Hardhat deployed-bytecode hashes for the exact public source commit.

| Contract | Toolchain | deployedBytecode keccak256 |
|---|---|---|
| `ParkTokenV1_2` (Foundry) | foundry 1.5.1-stable | **PENDING — generate from PR #42 public source before deploy** |
| `ParkTokenV1_2` (Hardhat) | hardhat 3.4.1 | **PENDING — generate from PR #42 public source before deploy** |

If your `forge --version` SHA differs from `b0a9dd9c`, hashes WILL drift — pin
to the exact toolchain via `foundryup --version b0a9dd9c` for reproducibility.
`scripts/repro.sh` asserts the SHA before computing hashes; CI does the same.

If hashes match every row above, the build environment is verified and downstream
work (review, deploy, monitoring) may proceed on the source code. If they
differ, do not proceed — diagnose toolchain drift first.

Each vendored library directory under `lib/` carries a `.vendored-info.txt`
recording the upstream commit SHA. Use these to diff against the upstream
repository to verify zero local modifications.
