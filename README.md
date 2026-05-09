# PARK Token (PARK)

ERC-20 utility token for earnpark.com, deployed on BNB Smart Chain via the
ZeframLou CREATE3 Factory for deterministic addressing across EVM chains.

PARK is the platform utility token used for staking, rewards, and governance
participation in the EarnPark ecosystem (https://earnpark.com).
The contract is a fixed-supply ERC-20 (1B total, 6 decimals) with UUPS upgradeability
under Safe + Timelock governance, USDC-style stuck-token rescue, ERC-2612 gasless
approvals, and a hard cap enforced at the `_update` level.

## Contract

- **Source:** `contracts/ParkToken.sol`
- **Standards:** ERC-20, ERC-2612 Permit, ERC-1967 UUPS proxy, ERC-7201 namespaced storage
- **OpenZeppelin v5.6.1** (capped, burnable, permit, access-control with default-admin-rules)

## Quick start

```bash
git clone <repository-url>
cd park-token
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
