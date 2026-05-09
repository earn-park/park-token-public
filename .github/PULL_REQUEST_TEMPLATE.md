## Summary

<!-- One-paragraph description -->

## Audit-trail checklist

- [ ] No changes to deployable contract bytecode (or PR description explains the bytecode delta).
- [ ] `forge fmt --check` clean.
- [ ] `forge test --offline` green.
- [ ] `npm run lint` clean.
- [ ] `npx tsc --noEmit` clean.
- [ ] `npm run deps:check-exact` clean (every dep exact-pinned).
- [ ] `scripts/repro.sh` output matches `docs/BYTECODE-BASELINE.md`, or baseline updated in the same PR.
- [ ] No internal-tooling references leaked (`superpowers`, `runbooks/`, `ParkTokenBase|Final|V2*`, parent `ops/`).
- [ ] Storage-layout regression test still green (`test_metadataNamespaceSlot_matchesERC7201`).

## Test plan

<!-- Steps the reviewer should execute -->
