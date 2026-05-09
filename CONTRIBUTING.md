# Contributing

This repository is the audit-handoff snapshot for PARK Token v1.0.0.
External pull requests during the active audit window are not the
intended workflow — please open an issue or contact the audit team
through the engagement channel.

After audit completion, contributions following the standard Github
flow (fork → branch → PR with passing CI) are welcome. By submitting
a contribution you agree to license it under the terms of the root
`LICENSE` (BUSL-1.1).

## Reproducibility

Every contribution must keep `forge test --offline` green and
`scripts/repro.sh` output bit-identical to the published baseline in
`docs/BYTECODE-BASELINE.md` (or the baseline must be updated in the
same PR).
