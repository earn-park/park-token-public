# Audit response

Team responses to the external security review (finding IDs `EAA-01`…`EAA-07`).
This document records the disposition of each finding; code-level fixes live in
the contract / test / deploy sources and are cross-referenced below.

**Final outcome** (external review final report, 2026-05-29): **0 Critical, 0 Major**;
7 findings total — **4 Resolved, 3 Acknowledged** (by design). Summary:

| ID | Severity | Final status |
|---|---|---|
| EAA-01 | Centralization | Acknowledged (disclosed, by design) |
| EAA-02 | Medium | **Resolved** |
| EAA-03 | Minor | Acknowledged (by design) |
| EAA-04 | Minor | **Resolved** |
| EAA-05 | Informational | Acknowledged (by design) |
| EAA-06 | Informational | **Resolved** |
| EAA-07 | Informational | **Resolved** |

---

## EAA-01 — Centralization (disposition: **disclosed, by design**)

**Finding.** `DEFAULT_ADMIN_ROLE`, `RESCUER_ROLE`, `UPGRADER_ROLE`, and the
`TimelockController` parameters concentrate protocol authority in a small set
of privileged entities. Recommended short-term Timelock + multisig, long-term
DAO, permanent renounce.

**Disposition.** The centralization is intentional for the launch phase and is
bounded by on-chain hardening plus a documented governance posture. We disclose
rather than change the design.

### What is already enforced on-chain

- **UPGRADER_ROLE is admin-hardened.** `initialize()` sets
  `_setRoleAdmin(UPGRADER_ROLE, TIMELOCK_ADMIN_ROLE)` and
  `_setRoleAdmin(TIMELOCK_ADMIN_ROLE, TIMELOCK_ADMIN_ROLE)` (self-administered),
  granting both only to the Timelock (`contracts/ParkToken.sol`). Consequently
  `DEFAULT_ADMIN_ROLE` **cannot** grant itself upgrade authority and bypass the
  Timelock — the strongest explicit guarantee in the role lattice
  (`docs/TOKEN-SPEC.md` role table + lattice).
- **Cap is immutable within the audited base implementation.** `cap()` is a
  `pure` override returning the `INITIAL_SUPPLY` constant
  (`contracts/ParkToken.sol`). The original v1.0 implementation exposed
  admin-gated `mint(to, amount)` up to that cap; the MEXC Stage 1 production
  upgrade (v1.1) removes the selector, so burned PARK is no longer
  re-issuable. The cap can change **only** through a Timelock-gated UUPS
  upgrade that ships a different implementation — not a silent admin action
  (see `docs/UPGRADE-HAZARDS.md` H-1).
- **Renounce / self-revoke guards.** `renounceRole` is blocked outright for
  `TIMELOCK_ADMIN_ROLE`, and `revokeRole` is blocked for self-revocation of it,
  so a single compromised holder cannot brick the upgrade path
  (`docs/UPGRADE-HAZARDS.md` H-2, `docs/THREAT-MODEL.md` T8).

### Governance posture (staging → production)

- **Staging / local default:** Timelock `minDelay` of **900 s** is the
  `.env.example` default for staging and local rehearsal only
  (`docs/TOKEN-SPEC.md` §Timelock minDelay policy).
- **Production target:** Timelock `minDelay` of **21 600 s (6 h)** with a Safe
  threshold of **≥ 3/5** (`docs/TOKEN-SPEC.md`, role lattice). Operators MUST
  raise `minDelay` to 21 600 s or higher before mainnet broadcast.

This satisfies the review's short-term recommendation (Timelock + multisig
combination) directly.

### On the "permanent renounce" recommendation

We reject blanket renounce of `DEFAULT_ADMIN_ROLE` as a default remedy: after
v1.1 it would disable `setContractURI()` (metadata updates), administration /
rotation of `RESCUER_ROLE`, and after v1.2 administration / rotation of
`PAUSER_ROLE`; it is no longer needed to remove mint authority because
`mint()` is absent from the implementation. However, the renounce path **is**
intentionally left open (`docs/UPGRADE-HAZARDS.md` H-6):
`DEFAULT_ADMIN_ROLE` renounce routes through OpenZeppelin
`AccessControlDefaultAdminRules` — a two-step transfer with the configured
`defaultAdminDelay` (≥ 24 h on-chain bound) — so a project that later wants to
credibly commit to "no further mints" can do so with a delayed, monitorable
action rather than an irreversible single call. `DefaultAdminTransferScheduled`
to `0x0` is flagged as a CRITICAL monitoring alert.

### On the "long-term DAO" recommendation

A DAO / on-chain voting module is product roadmap, not v1 scope. It will be
evaluated after TGE once operational confidence on BSC has accrued. No code
change in this audit cycle.

**Net:** code unchanged for EAA-01; this is the disclosure of an intentional,
on-chain-bounded centralization profile with a documented production-uplift
target.

---

## EAA-02 … EAA-07 (disposition: **fixed / documented**)

| ID | Severity | Disposition | Where |
|---|---|---|---|
| EAA-02 | Medium | **Resolved**, defence in depth: (1) on-chain — `ParkERC1967Proxy` constructor reverts `UnexpectedInitSelector` unless the init calldata invokes `ParkToken.initialize`; (2) off-chain — post-deploy assertion that `initialize()` is consumed (reverts `InvalidInitialization()`) | `contracts/imports/ERC1967ProxyImport.sol`, `scripts/deploy/base/deploy-bsc.ts` (`runPostDeployAssertions`) |
| EAA-03 | Minor | Documented: pairwise distinctness is deploy-time hygiene, not a runtime invariant; `RESCUER_ROLE` admin is `DEFAULT_ADMIN_ROLE` by design for key rotation | `contracts/ParkToken.sol` (`_validateInitConfig` NatSpec) |
| EAA-04 | Minor | In audited v1.0, `mint()` reverts `ERC20ExceededCap(amount, cap)` — well-defined payload for all uint256 inputs (no overflow wrap). In production v1.1+, the MEXC path removes `mint()` entirely. | `contracts/ParkToken.sol` (`mint`), `contracts/ParkTokenV1_1.sol` |
| EAA-05 | Informational | Documented: the `upgrader.code.length` check is a coarse not-EOA guard; full Timelock topology is verified off-chain by `runPostDeployAssertions` | `contracts/ParkToken.sol` (`_validateInitConfig` NatSpec) |
| EAA-06 | Informational | `ContractURIUpdated(string previousURI, string newURI, address indexed operator)` — adds previous URI + operator | `contracts/ParkToken.sol` (event + emit sites) |
| EAA-07 | Informational | Cap-storage ERC-7201 regression tests added + mandated for every successor impl | `test/ParkToken.t.sol`, `docs/UPGRADE-HAZARDS.md` H-1 |

No Critical or Major findings were reported.
