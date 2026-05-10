// Sablier-style follow-up to scripts/ops/schedule-upgrade.ts.
// Reads a schedule manifest, checks readiness, executes via the Timelock,
// runs post-upgrade verification, and persists an entry to the per-chain
// upgrade-ledger so the schedule->execute lifecycle is durable on-disk.
//
// Closes audit-2026-05-10 H-04 (execution lifecycle has no helper / ledger
// and accepts low-delay posture; raw `cast send` was the previous path).
//
// Required env (via chain-resolver):
//   TARGET_CHAIN              — bsc | bscTestnet | arbitrum
//   {CHAIN}_RPC_URL, {CHAIN}_PRIVATE_KEY
// Required schedule inputs (one of):
//   SCHEDULE_MANIFEST_PATH    — JSON file written by schedule-upgrade.ts
//                               under ops/ (e.g. ops/upgrade-schedule-bsc-<opId>.json)
//   OR all of:
//     PROXY_ADDRESS, TIMELOCK_ADDRESS, NEW_IMPL_ADDRESS,
//     UPGRADE_SALT_LABEL  (must match what schedule-upgrade.ts used)
//     REINIT_CALLDATA     (default "0x")
//     TIMELOCK_PREDECESSOR (default 0x00..0)
// Optional:
//   EXPECTED_OPERATION_ID     — bytes32; if set, must match recomputed id
//   EXPECTED_OLD_IMPL         — address; ERC-1967 slot pre-upgrade
//   EXPECTED_NEW_IMPL_VERSION — string; implVersion() post-upgrade
//   PRODUCTION_MODE           — "true" enforces the documented production
//                               Timelock floor (>=21600s); aborts otherwise.
//   LEDGER_PATH               — where to append the execute receipt;
//                               default ops/upgrade-ledger-<chain>.json

import "dotenv/config";
import {existsSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  stringToBytes,
  type Address,
  type Hex
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {resolveChain, type SupportedChainKey} from "./chain-resolver.js";

const PRODUCTION_TIMELOCK_FLOOR = 21600;

const TIMELOCK_ABI = [
  {type: "function", name: "execute", stateMutability: "payable",
   inputs: [{name: "target", type: "address"}, {name: "value", type: "uint256"}, {name: "payload", type: "bytes"},
            {name: "predecessor", type: "bytes32"}, {name: "salt", type: "bytes32"}], outputs: []},
  {type: "function", name: "hashOperation", stateMutability: "pure",
   inputs: [{name: "target", type: "address"}, {name: "value", type: "uint256"}, {name: "data", type: "bytes"},
            {name: "predecessor", type: "bytes32"}, {name: "salt", type: "bytes32"}], outputs: [{type: "bytes32"}]},
  {type: "function", name: "isOperationReady", stateMutability: "view",
   inputs: [{name: "id", type: "bytes32"}], outputs: [{type: "bool"}]},
  {type: "function", name: "isOperationDone", stateMutability: "view",
   inputs: [{name: "id", type: "bytes32"}], outputs: [{type: "bool"}]},
  {type: "function", name: "getMinDelay", stateMutability: "view",
   inputs: [], outputs: [{type: "uint256"}]},
  {type: "event", name: "CallExecuted", anonymous: false,
   inputs: [{indexed: true, name: "id", type: "bytes32"}, {indexed: true, name: "index", type: "uint256"},
            {name: "target", type: "address"}, {name: "value", type: "uint256"}, {name: "data", type: "bytes"}]}
] as const;

const PROXY_ABI = [
  {type: "function", name: "implVersion", stateMutability: "pure", inputs: [], outputs: [{type: "string"}]},
  {type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{type: "bytes32"}]},
  {type: "event", name: "Upgraded", anonymous: false,
   inputs: [{indexed: true, name: "implementation", type: "address"}]}
] as const;

const UPGRADE_ABI = [
  {type: "function", name: "upgradeToAndCall", stateMutability: "payable",
   inputs: [{name: "newImplementation", type: "address"}, {name: "data", type: "bytes"}], outputs: []}
] as const;

const ERC1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;

function require_(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") throw new Error(`Missing env: ${name}`);
  return v.trim();
}

interface ScheduleArtefact {
  proxyAddress: Address;
  timelockAddress: Address;
  newImplAddress: Address;
  upgradeCalldata: Hex;
  reinitCalldata: Hex;
  predecessor: Hex;
  saltLabel: string;
  salt: Hex;
  operationId: Hex;
  delaySeconds: number;
  scheduledAtUnix?: number;
  scheduleTxHash?: Hex;
}

function loadScheduleArtefact(): ScheduleArtefact {
  const manifestPath = process.env["SCHEDULE_MANIFEST_PATH"];
  if (manifestPath !== undefined && manifestPath.trim() !== "" && existsSync(manifestPath)) {
    const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
    return {
      proxyAddress: m.proxyAddress,
      timelockAddress: m.timelockAddress,
      newImplAddress: m.newImplAddress,
      upgradeCalldata: m.upgradeCalldata,
      reinitCalldata: m.reinitCalldata ?? "0x",
      predecessor: m.predecessor ?? `0x${"0".repeat(64)}`,
      saltLabel: m.saltLabel,
      salt: m.salt,
      operationId: m.operationId,
      delaySeconds: m.delaySeconds,
      scheduledAtUnix: m.scheduledAtUnix,
      scheduleTxHash: m.scheduleTxHash
    };
  }
  // Inline-args fallback for ad-hoc execution.
  const proxy = require_("PROXY_ADDRESS") as Address;
  const timelock = require_("TIMELOCK_ADDRESS") as Address;
  const newImpl = require_("NEW_IMPL_ADDRESS") as Address;
  const reinit = (process.env["REINIT_CALLDATA"] ?? "0x") as Hex;
  const predecessor = (process.env["TIMELOCK_PREDECESSOR"] ?? `0x${"0".repeat(64)}`) as Hex;
  const saltLabel = require_("UPGRADE_SALT_LABEL");
  const salt = keccak256(stringToBytes(saltLabel));
  const upgradeCalldata = encodeFunctionData({
    abi: UPGRADE_ABI, functionName: "upgradeToAndCall", args: [newImpl, reinit]
  });
  return {
    proxyAddress: proxy, timelockAddress: timelock, newImplAddress: newImpl,
    upgradeCalldata, reinitCalldata: reinit, predecessor, saltLabel, salt,
    operationId: "0x" as Hex, // recomputed below
    delaySeconds: 0
  };
}

async function main(): Promise<void> {
  const targetChain = require_("TARGET_CHAIN");
  const resolved = resolveChain(process.env);
  const rpcUrl = require_(resolved.rpcEnvName);
  const pkRaw = require_(resolved.privateKeyEnvName);
  const account = privateKeyToAccount(pkRaw.startsWith("0x") ? (pkRaw as Hex) : (`0x${pkRaw}` as Hex));

  const transport = http(rpcUrl);
  const publicClient = createPublicClient({chain: resolved.chain, transport});
  const walletClient = createWalletClient({account, chain: resolved.chain, transport});

  const chainId = await publicClient.getChainId();
  if (chainId !== resolved.chain.id) {
    throw new Error(`Wrong chainId ${chainId}, expected ${resolved.chain.id}`);
  }

  const sched = loadScheduleArtefact();
  console.log(`Network:         ${targetChain} (chainId=${chainId})`);
  console.log(`Proxy:           ${sched.proxyAddress}`);
  console.log(`Timelock:        ${sched.timelockAddress}`);
  console.log(`New impl:        ${sched.newImplAddress}`);
  console.log(`Salt label:      ${sched.saltLabel}`);

  // Recompute operation id and cross-check the schedule artefact.
  const recomputedOpId = (await publicClient.readContract({
    address: sched.timelockAddress, abi: TIMELOCK_ABI, functionName: "hashOperation",
    args: [sched.proxyAddress, 0n, sched.upgradeCalldata, sched.predecessor, sched.salt]
  })) as Hex;
  console.log(`OpId (recomputed): ${recomputedOpId}`);
  if (sched.operationId !== "0x" && sched.operationId.toLowerCase() !== recomputedOpId.toLowerCase()) {
    throw new Error(
      `OpId drift: schedule artefact = ${sched.operationId}, recomputed = ${recomputedOpId}. ` +
        `Refusing to execute — verify salt/predecessor/calldata match the original schedule.`
    );
  }
  const expectedOpId = process.env["EXPECTED_OPERATION_ID"];
  if (expectedOpId !== undefined && expectedOpId.trim() !== "" &&
      expectedOpId.toLowerCase() !== recomputedOpId.toLowerCase()) {
    throw new Error(`EXPECTED_OPERATION_ID mismatch: got ${recomputedOpId}, expected ${expectedOpId}`);
  }

  // Production-floor enforcement (audit H-04 sub-issue).
  const productionMode = (process.env["PRODUCTION_MODE"] ?? "false").trim().toLowerCase() === "true";
  if (productionMode) {
    const liveDelay = (await publicClient.readContract({
      address: sched.timelockAddress, abi: TIMELOCK_ABI, functionName: "getMinDelay"
    })) as bigint;
    if (liveDelay < BigInt(PRODUCTION_TIMELOCK_FLOOR)) {
      throw new Error(
        `PRODUCTION_MODE=true requires Timelock minDelay >= ${PRODUCTION_TIMELOCK_FLOOR}s; live=${liveDelay}s. Refusing to execute.`
      );
    }
    console.log(`  PASS: Timelock minDelay ${liveDelay}s meets production floor`);
  }

  // Readiness gate.
  const isReady = (await publicClient.readContract({
    address: sched.timelockAddress, abi: TIMELOCK_ABI, functionName: "isOperationReady", args: [recomputedOpId]
  })) as boolean;
  const isDone = (await publicClient.readContract({
    address: sched.timelockAddress, abi: TIMELOCK_ABI, functionName: "isOperationDone", args: [recomputedOpId]
  })) as boolean;
  if (isDone) throw new Error(`Operation ${recomputedOpId} already executed; nothing to do.`);
  if (!isReady) {
    throw new Error(
      `Operation ${recomputedOpId} not ready yet (minDelay not elapsed OR not scheduled). ` +
        `Wait until isOperationReady returns true; check timestamp via Timelock.getTimestamp(opId).`
    );
  }
  console.log(`  PASS: operation ${recomputedOpId} is ready`);

  // Pre-execute snapshot for ledger.
  const oldImplRaw = await publicClient.getStorageAt({address: sched.proxyAddress, slot: ERC1967_IMPL_SLOT});
  const oldImpl = (oldImplRaw ? `0x${oldImplRaw.slice(-40)}` : `0x${"0".repeat(40)}`) as Address;
  const expectedOldImpl = process.env["EXPECTED_OLD_IMPL"];
  if (expectedOldImpl !== undefined && expectedOldImpl.trim() !== "" &&
      expectedOldImpl.toLowerCase() !== oldImpl.toLowerCase()) {
    throw new Error(`EXPECTED_OLD_IMPL mismatch: got ${oldImpl}, expected ${expectedOldImpl}`);
  }
  console.log(`Pre-exec impl:   ${oldImpl}`);

  // Broadcast.
  console.log(`\nBroadcasting Timelock.execute(...)...`);
  const txHash = await walletClient.writeContract({
    address: sched.timelockAddress, abi: TIMELOCK_ABI, functionName: "execute",
    args: [sched.proxyAddress, 0n, sched.upgradeCalldata, sched.predecessor, sched.salt]
  });
  console.log(`  tx: ${txHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({hash: txHash});
  if (receipt.status !== "success") throw new Error(`execute reverted: ${txHash}`);
  console.log(`  ✓ block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);

  // Post-execute verification.
  console.log(`\n=== Post-execute verification ===`);
  const newImplRaw = await publicClient.getStorageAt({address: sched.proxyAddress, slot: ERC1967_IMPL_SLOT});
  const newImplLive = (newImplRaw ? `0x${newImplRaw.slice(-40)}` : "0x") as Address;
  if (newImplLive.toLowerCase() !== sched.newImplAddress.toLowerCase()) {
    throw new Error(`ERC1967 impl slot mismatch post-upgrade: got ${newImplLive}, expected ${sched.newImplAddress}`);
  }
  console.log(`  PASS: ERC1967 impl slot == ${newImplLive}`);

  const isDoneAfter = (await publicClient.readContract({
    address: sched.timelockAddress, abi: TIMELOCK_ABI, functionName: "isOperationDone", args: [recomputedOpId]
  })) as boolean;
  if (!isDoneAfter) throw new Error(`Timelock.isOperationDone(${recomputedOpId}) returned false post-execute`);
  console.log(`  PASS: Timelock marks operation done`);

  const expectedNewVersion = process.env["EXPECTED_NEW_IMPL_VERSION"];
  let liveImplVersion: string | null = null;
  try {
    liveImplVersion = (await publicClient.readContract({
      address: sched.proxyAddress, abi: PROXY_ABI, functionName: "implVersion"
    })) as string;
    console.log(`  implVersion(): "${liveImplVersion}"`);
    if (expectedNewVersion !== undefined && expectedNewVersion.trim() !== "" &&
        liveImplVersion !== expectedNewVersion) {
      throw new Error(`implVersion() "${liveImplVersion}" != EXPECTED_NEW_IMPL_VERSION "${expectedNewVersion}"`);
    }
  } catch (err) {
    if (expectedNewVersion !== undefined) {
      throw new Error(`Failed to read implVersion(): ${(err as Error).message}`);
    }
    console.log(`  INFO: implVersion() unavailable (new impl may not expose it); skipping`);
  }

  // Domain separator should rotate iff the new impl bumps name/version OR
  // chainid/proxy address changes. Just log it for forensic completeness.
  let domainSeparator: Hex | null = null;
  try {
    domainSeparator = (await publicClient.readContract({
      address: sched.proxyAddress, abi: PROXY_ABI, functionName: "DOMAIN_SEPARATOR"
    })) as Hex;
    console.log(`  DOMAIN_SEPARATOR: ${domainSeparator}`);
  } catch {
    console.log(`  INFO: DOMAIN_SEPARATOR unavailable on new impl`);
  }

  // Append to durable ledger (audit H-04).
  const ledgerPath = process.env["LEDGER_PATH"] ??
    join(process.cwd(), `ops/upgrade-ledger-${targetChain}.json`);
  const existing = existsSync(ledgerPath)
    ? JSON.parse(readFileSync(ledgerPath, "utf-8"))
    : {chain: targetChain, chainId, executions: []};
  existing.executions.push({
    timestamp: new Date().toISOString(),
    operationId: recomputedOpId,
    proxyAddress: sched.proxyAddress,
    timelockAddress: sched.timelockAddress,
    oldImplAddress: oldImpl,
    newImplAddress: sched.newImplAddress,
    saltLabel: sched.saltLabel,
    salt: sched.salt,
    predecessor: sched.predecessor,
    delaySeconds: sched.delaySeconds,
    scheduleTxHash: sched.scheduleTxHash ?? null,
    executeTxHash: txHash,
    executeBlock: Number(receipt.blockNumber),
    executeGasUsed: Number(receipt.gasUsed),
    postExecuteChecks: {
      erc1967ImplSlot: newImplLive,
      implVersion: liveImplVersion,
      domainSeparator: domainSeparator,
      timelockMarksDone: isDoneAfter
    }
  });
  writeFileSync(ledgerPath, `${JSON.stringify(existing, null, 2)}\n`);
  console.log(`\nLedger appended: ${ledgerPath}`);

  console.log(`\nNEXT: re-mark proxy on the explorer for the new impl.`);
  console.log(`See docs/UPGRADE-HAZARDS.md H-5 for the verifyproxycontract API call.`);
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv.some((a) => a.includes("execute-upgrade"));
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
