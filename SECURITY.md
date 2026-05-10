# Security Policy

## Reporting a vulnerability

Please **do not** file a public GitHub issue for security vulnerabilities.

Email: `security@earnpark.com` (PGP key on request)

We commit to:
- Acknowledge receipt within 2 business days.
- Provide a status update within 5 business days.
- Not pursue legal action against good-faith researchers who follow this
  process and do not exfiltrate user data, disrupt service, or violate
  privacy.

## Audit window

This repository is the audit-handoff snapshot for PARK Token v1.0.0.
The token's first production deployment will happen post-audit; any
on-chain instances at the time of audit (BSC mainnet, Arbitrum One)
are test rehearsals and are not load-bearing for the audit
scope. Auditor's reasoning should attach to the source in this repo,
not to any specific deployed proxy.

During the active audit period, security-impacting findings should be
disclosed through the auditor's communication channel as well as via
this email.

## Out of scope

- Vulnerabilities in third-party dependencies vendored under `lib/` —
  those are tracked upstream (OpenZeppelin, forge-std). Transitive npm
  package alerts inside `lib/openzeppelin-contracts/**` (OpenZeppelin's
  own JS tooling) do not affect compiled contract bytecode and are
  acknowledged as low-priority.
- Issues that require unrealistic preconditions (e.g., compromised
  Timelock + compromised Safe simultaneously).
- Theoretical block-explorer indexing issues that do not affect on-chain
  state.

## In scope

- Bytecode-level issues in `contracts/ParkToken.sol`,
  `contracts/imports/ERC1967ProxyImport.sol`, and
  `contracts/imports/TimelockControllerImport.sol`.
- Storage-layout / namespace-collision risks for upgrade safety.
- Role-based access-control logic.
- ERC-2612 permit, ERC-20 Capped, AccessControl, UUPS upgradeability.
- Build-reproducibility issues (deployed bytecode != reproduced bytecode
  from this repo).
