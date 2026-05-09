# Threat model

This document enumerates 9 operational threats (T1–T9) relevant to the CREATE3
deploy mechanic and governance lifecycle. Contract-level invariants and bytecode-
level concerns are covered separately in `docs/TOKEN-SPEC.md` §Invariants.

---

## T1. CREATE3 factory substitution

**Threat:** An attacker substitutes a malicious contract at the ZeframLou factory address
before the deploy transaction, causing the proxy to be deployed from attacker-controlled
code.

**Mitigation:** `verifyExtcodehash()` in `deploy-bsc.ts` aborts if the runtime bytecode at
`0x6aA3D87e99286946161dCA02B97C5806fC5eD46F` does not match the expected extcodehash
`0x00b17219fb16a322d231dc1830789d7936d3547bedd9feed313445001dc21e37`. This runs as a
pre-flight check before any transaction is broadcast. ZeframLou's factory was deployed via
Nick's method (keyless), making it immutable; substitution would require the deployer private
key or a chain-level reorg.

---

## T2. CREATE3 salt front-run

**Threat:** An attacker observing the mempool front-runs the `factory.deploy(salt, initcode)`
call with the same salt, deploying a different contract to the predicted address.

**Mitigation:** ZeframLou's factory uses `effectiveSalt = keccak256(msg.sender ++ userSalt)`,
so the effective salt is keyed to the original deployer address. A front-runner using a
different EOA will derive a different effective salt and therefore a different proxy address.
The predicted address check in `preClaimSafetyCheck` catches any race condition before gas
is spent on Timelock + impl deploy.

---

## T3. Implementation address front-run

**Threat:** An attacker observes the impl address in the mempool and passes it as the `logic`
arg to a malicious proxy constructor, initializing their own proxy with our impl before we
do.

**Mitigation:** The impl address appears in the `initcode` passed to the factory, not as a
plain argument. Even if an attacker deploys their own proxy pointing to our impl, the
`initialize` calldata within the factory initcode references addresses under our control.
Our proxy initialization is atomic within the `factory.deploy` transaction.

---

## T4. Initializer race

**Threat:** A bot or attacker calls `initialize()` on the implementation contract directly
before our proxy is wired up, seizing admin roles.

**Mitigation:** The `ParkToken` constructor calls `_disableInitializers()`. Any call to
`initialize()` on the bare implementation reverts with `InvalidInitialization`. The proxy's
initialization is triggered atomically by the ERC1967Proxy constructor in the same
`factory.deploy` transaction.

---

## T5. Governance compromise at deploy

**Threat:** If the deployer key or the Safe is compromised at the moment of deploy, the
attacker could pass malicious addresses into `InitConfig` (e.g., setting themselves as
`defaultAdmin` or `upgrader`).

**Mitigation:** The `InitConfig` addresses are supplied via environment variables
(`BSC_DEFAULT_ADMIN_ADDRESS`, `BSC_RESCUER_ADDRESS`, etc., resolved by `resolveBscEnv()`).
Operator MUST verify each value matches agreed governance parameters before broadcasting.
Post-deploy assertions (`runPostDeployAssertions`) verify every role on-chain before the
manifest is written.

---

## T6. Salt loss

**Threat:** The CREATE3 salt is lost or changed, preventing deterministic re-deploy on
additional EVM chains with the same proxy address.

**Mitigation:** The salt is `PARK_TOKEN_SALT` defined in
`scripts/deploy/base/create3-factory.ts`. Computed once at module load via
`keccak256(toHex("earnpark.parktoken.v1.proxy"))`. The value is committed to version control
permanently. The salt is also recorded in the deploy manifest.

---

## T7. Network censorship / RPC failure

**Threat:** The RPC endpoint is unavailable or censors transactions during the deploy
sequence, leaving Timelock + impl deployed without the proxy.

**Mitigation:** The deploy script uses `waitForTransactionReceipt` with explicit failure
checks after each of the three sequential transactions. If any step fails, the script
aborts and reports the failure. The Timelock and impl are reusable; a fresh attempt can
pick up from where it left off. Use a reliable RPC endpoint with failover support.

---

## T8. TIMELOCK_ADMIN_ROLE compromise + colluding rotation

**Threat:** A compromised Timelock could grant `TIMELOCK_ADMIN_ROLE` to an attacker-controlled
colluder, then have the colluder revoke the original holder, concentrating upgrade authority.

**Mitigation:** The renounce/self-revoke guards block the simple brick path (single holder
cannot remove themselves). Cross-holder revoke is allowed for legitimate Timelock rotation. A
fully compromised Timelock already has full upgrade power via the existing `UPGRADER_ROLE` —
the rotation does not add new attack capability. See `docs/UPGRADE-HAZARDS.md` H-2 for full reasoning.

---

## T9. Permit replay across chains

**Threat:** A permit signature valid on one EVM chain is replayed on another chain where
the same proxy address exists (enabled by CREATE3 determinism).

**Mitigation:** EIP-2612 `DOMAIN_SEPARATOR` includes `chainId` and `address(this)`. A
signature created for BSC chainId 56 is invalid on any other chain. OZ's
`ERC20PermitUpgradeable` implements this correctly; `test_permit_revertsReplay` verifies
replay is rejected even on the same chain.
