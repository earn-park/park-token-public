# PARK Token (PARK)

ERC-20 utility token for earnpark.com, deployed on BNB Smart Chain via the
ZeframLou CREATE3 Factory for deterministic addressing across EVM chains.

PARK is the platform utility token used for staking, rewards, and governance
participation in the EarnPark ecosystem (https://earnpark.com).
The contract is a **capped-supply** ERC-20 (1 B PARK hard cap, 6 decimals) with
**admin reissuance up to the cap**: holder burns reduce `totalSupply()` and
create headroom that `DEFAULT_ADMIN_ROLE` can mint back via `mint()`. The cap
itself is immutable (returned by a `pure` override). Other surface: UUPS
upgradeability under Safe + Timelock governance, USDC-style stuck-token
rescue, ERC-2612 gasless approvals, and the hard cap enforced at the
`_update` level. See `docs/TOKEN-SPEC.md` for the full surface and
`docs/UPGRADE-HAZARDS.md` for the cap-storage upgrade contract.

## Contract

- **Source:** `contracts/ParkToken.sol`
- **Standards:** ERC-20, ERC-2612 Permit, ERC-1967 UUPS proxy, ERC-7201 namespaced storage
- **OpenZeppelin v5.6.1** (capped, burnable, permit, access-control with default-admin-rules)

PARK Token uses four AccessControl roles: `DEFAULT_ADMIN_ROLE` (held by Safe), `UPGRADER_ROLE` (held by Timelock), `RESCUER_ROLE` (held by a dedicated rescuer EOA), and `TIMELOCK_ADMIN_ROLE` (held by Timelock; the only role that can grant/revoke `UPGRADER_ROLE`).

## Quick start

```bash
git clone <repository-url>
cd park-token-public
# lib/ is fully vendored — no submodule init needed
npm install --ignore-scripts
forge build --offline        # Foundry artifacts (out/) — authoritative for audit
npx hardhat compile          # Hardhat artifacts (artifacts/) — required for TS tests
forge test --offline -vvv    # 85 Foundry tests (77 unit + 8 invariant)
npm run hh:test              # 34 TS unit tests
```

Expected output: 85 Foundry tests pass (77 unit + 8 invariant) plus 34 TS unit tests.

## Deploy (BSC mainnet)

See `docs/DEPLOY-MECHANIC.md` for the full operator runbook. Short version:

```bash
cp .env.example .env
# fill in BSC_RPC_URL, BSC_PRIVATE_KEY, BSC_DEFAULT_ADMIN_ADDRESS, etc.
npm run hh:deploy:base:bsc
```

## Reproducibility verification

To verify the bytecode an auditor builds matches the documented baseline:
```bash
./scripts/repro.sh
```

Compare the printed hashes against the table in `docs/BYTECODE-BASELINE.md`.

## Audit

This repository is submitted for external security audit. See `docs/AUDIT-SCOPE.md` for in-scope files.

## License

BUSL-1.1 — see `LICENSE`.

All files in this repository, including TypeScript scripts and shell utilities, are governed by the root `LICENSE` (BUSL-1.1) unless they carry a different SPDX identifier.
