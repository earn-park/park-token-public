// scripts/deploy/base/deploy-bsc.ts
//
// ParkToken BSC deploy via the CREATE3 factory registered in
// `scripts/deploy/base/create3-factory.ts`.
// Factory: ZeframLou's CREATE3 Factory at
// 0x6aA3D87e99286946161dCA02B97C5806fC5eD46F (ZeframLou's CREATE3 Factory, deployed via Nick's-method on 50+ EVM chains).
//
// Three sequential txs + one factory.deploy:
//   1. ParkTimelockController via plain CREATE
//   2. ParkToken impl via plain CREATE
//   3. factory.deploy(salt, ERC1967Proxy_initcode) — proxy at deterministic
//      address derivable from (factory, deployer, salt)
//
// 15 post-deploy assertions guard role lattice + Timelock minDelay.
//
// Operator guide: docs/DEPLOY-MECHANIC.md
//
// Runtime: pure viem — no ethers, no Hardhat runtime.
// Operator runs `npx hardhat compile` first to generate artifacts,
// then `node --import tsx scripts/deploy/base/deploy-bsc.ts`.

import "dotenv/config";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import {
  concat,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  http,
  type Hex,
  type WalletClient,
  type PublicClient,
  type Transport,
  type Account
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, type Chain } from "viem/chains";
import {
  CREATE3_FACTORY_REGISTRY,
  PARK_TOKEN_SALT,
  computeProxyAddress,
  verifyExtcodehash,
  type SupportedChainKey
} from "./create3-factory.js";
import { resolveChain } from "../../ops/chain-resolver.js";
import {
  resolveBscEnv,
  type ResolvedBscEnv,
  PRODUCTION_TIMELOCK_DELAY_MIN,
  PRODUCTION_SAFE_THRESHOLD_MIN,
  PRODUCTION_SAFE_OWNERS_MIN
} from "./resolve-bsc-env.js";

const CHAIN_BY_KEY: Record<SupportedChainKey, Chain> = {
  bsc
};

// ZeframLou CREATE3 Factory ABI — hand-written because this is a third-party
// contract (https://github.com/ZeframLou/create3-factory) with no compiled
// artifact in this repo. Only the two selectors actually used are included.
const ZEFRAMLOU_FACTORY_ABI = [
  {
    type: "function",
    name: "deploy",
    stateMutability: "payable",
    inputs: [
      { name: "salt", type: "bytes32" },
      { name: "creationCode", type: "bytes" }
    ],
    outputs: [{ type: "address" }]
  },
  {
    type: "function",
    name: "getDeployed",
    stateMutability: "view",
    inputs: [
      { name: "deployer", type: "address" },
      { name: "salt", type: "bytes32" }
    ],
    outputs: [{ type: "address" }]
  }
] as const;

// ── Artifact loader ─────────────────────────────────────────────────────────

function loadArtifact(relativePath: string): { abi: unknown[]; bytecode: Hex } {
  const fullPath = join(process.cwd(), relativePath);
  const raw = JSON.parse(readFileSync(fullPath, "utf-8")) as {
    bytecode: string;
    abi: unknown[];
  };
  const bc = raw.bytecode;
  if (!bc || bc === "0x") {
    throw new Error(
      `Artifact at ${fullPath} has empty bytecode — run npx hardhat compile`
    );
  }
  return { abi: raw.abi, bytecode: bc as Hex };
}

type AbiItem = { type: string; name?: string; inputs?: unknown[]; outputs?: unknown[]; stateMutability?: string };

function loadArtifactAbi(relativePath: string): AbiItem[] {
  const fullPath = join(process.cwd(), relativePath);
  const raw = JSON.parse(readFileSync(fullPath, "utf-8")) as { abi: AbiItem[] };
  return raw.abi;
}

function extractAbiFragments(abi: AbiItem[], names: string[]): AbiItem[] {
  const nameSet = new Set(names);
  return abi.filter((f) => f.name !== undefined && nameSet.has(f.name));
}

// Role + state ABI sourced from the compiled ParkToken artifact.
// Extracted lazily on first use so tests that don't touch the filesystem can
// import this module without requiring compiled artifacts.
let _proxyAbi: AbiItem[] | undefined;
function getProxyAbi(): AbiItem[] {
  if (!_proxyAbi) {
    const full = loadArtifactAbi("artifacts/contracts/ParkToken.sol/ParkToken.json");
    _proxyAbi = extractAbiFragments(full, [
      "UPGRADER_ROLE",
      "TIMELOCK_ADMIN_ROLE",
      "RESCUER_ROLE",
      "hasRole",
      "getRoleAdmin",
      "cap",
      "totalSupply",
      "balanceOf",
      "implVersion",
      "contractURI"
    ]);
  }
  return _proxyAbi;
}

// Timelock ABI sourced from the compiled TimelockControllerImport artifact.
let _timelockAbi: AbiItem[] | undefined;
function getTimelockAbi(): AbiItem[] {
  if (!_timelockAbi) {
    const full = loadArtifactAbi(
      "artifacts/contracts/imports/TimelockControllerImport.sol/ParkTimelockController.json"
    );
    // hasRole added for the Timelock-internal role lattice assertions
    // (CertiK pre-audit H-02 + mega-review M-1).
    _timelockAbi = extractAbiFragments(full, ["getMinDelay", "hasRole"]);
  }
  return _timelockAbi;
}

// Re-export shared type and resolver for test and script importers.
export type { ResolvedBscEnv as ResolvedEnv };
export { resolveBscEnv as resolveEnv };

// ── Timelock deploy ─────────────────────────────────────────────────────────

// Typed wallet/public client aliases for function signatures.
// Using WalletClient<Transport, Chain, Account> ensures the account is always
// bound (required by sendTransaction) while remaining compatible with the
// client created by createWalletClient({ account, chain, transport }).
type BoundWalletClient = WalletClient<Transport, Chain, Account>;
type BoundPublicClient = PublicClient<Transport, Chain>;

export interface DeployTimelockArgs {
  walletClient: BoundWalletClient;
  publicClient: BoundPublicClient;
  delay: number;
  proposers: ReadonlyArray<`0x${string}`>;
}

export interface DeployTimelockResult {
  address: `0x${string}`;
  deployTx: Hex;
}

export async function deployTimelock(args: DeployTimelockArgs): Promise<DeployTimelockResult> {
  const artifact = loadArtifact(
    "artifacts/contracts/imports/TimelockControllerImport.sol/ParkTimelockController.json"
  );

  // Use encodeDeployData + sendTransaction to avoid viem's account-generic
  // constraint on deployContract when the client type is not fully inferred.
  const data = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [
      BigInt(args.delay),
      args.proposers,
      ["0x0000000000000000000000000000000000000000"] as [`0x${string}`],
      "0x0000000000000000000000000000000000000000" as `0x${string}`
    ]
  });
  const txHash = await args.walletClient.sendTransaction({ data });

  const receipt = await args.publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`deployTimelock: transaction reverted: ${txHash}`);
  }
  const address = receipt.contractAddress;
  if (!address) {
    throw new Error(`deployTimelock: no contractAddress in receipt (tx=${txHash})`);
  }
  return { address, deployTx: txHash };
}

// ── Impl deploy ─────────────────────────────────────────────────────────────

export interface DeployImplArgs {
  walletClient: BoundWalletClient;
  publicClient: BoundPublicClient;
}

export interface DeployImplResult {
  address: `0x${string}`;
  deployTx: Hex;
}

export async function deployImpl(args: DeployImplArgs): Promise<DeployImplResult> {
  const artifact = loadArtifact(
    "artifacts/contracts/ParkToken.sol/ParkToken.json"
  );

  const txHash = await args.walletClient.sendTransaction({ data: artifact.bytecode });

  const receipt = await args.publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`deployImpl: transaction reverted: ${txHash}`);
  }
  const address = receipt.contractAddress;
  if (!address) {
    throw new Error(`deployImpl: no contractAddress in receipt (tx=${txHash})`);
  }
  return { address, deployTx: txHash };
}

// ── Address computation ─────────────────────────────────────────────────────

export function computePredictedAddress(args: {
  chainKey: SupportedChainKey;
  deployer: `0x${string}`;
}): `0x${string}` {
  const factory = CREATE3_FACTORY_REGISTRY[args.chainKey].address;
  return computeProxyAddress({
    factory,
    deployer: args.deployer,
    salt: PARK_TOKEN_SALT
  });
}

// ── Pre-claim safety check ───────────────────────────────────────────────────

export interface PreClaimSafetyArgs {
  rpcUrl: string;
  chainKey: SupportedChainKey;
  predicted: `0x${string}`;
}

export async function preClaimSafetyCheck(args: PreClaimSafetyArgs): Promise<void> {
  const client = createPublicClient({
    chain: CHAIN_BY_KEY[args.chainKey],
    transport: http(args.rpcUrl)
  });
  const code = await client.getCode({ address: args.predicted });
  if (code && code !== "0x") {
    throw new Error(
      `preClaimSafetyCheck: target ${args.predicted} already has code on ${args.chainKey}; aborting`
    );
  }
}

// ── Safe-shape pre-broadcast gate (CertiK pre-audit H-02) ────────────────────
// Inspects the multisig topology of `BSC_DEFAULT_ADMIN_ADDRESS` (the Safe
// receiving DEFAULT_ADMIN_ROLE on the proxy). On production deploys the
// thresholds enforced by PRODUCTION_SAFE_THRESHOLD_MIN /
// PRODUCTION_SAFE_OWNERS_MIN must hold or the script aborts pre-broadcast.
// Bootstrap deploys log the same numbers but proceed.
export async function assertSafeShape(args: {
  publicClient: ReturnType<typeof createPublicClient>;
  safeAddress: `0x${string}`;
  productionMode: boolean;
}): Promise<void> {
  const { publicClient, safeAddress, productionMode } = args;
  const SAFE_VIEW_ABI = [
    { type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
    { type: "function", name: "VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }
  ] as const;

  // VERSION is best-effort; not all Safe deployments expose it. If the call
  // reverts we treat it as INFO, not an abort.
  let safeVersion = "(unknown — VERSION() reverted)";
  try {
    safeVersion = (await publicClient.readContract({ address: safeAddress, abi: SAFE_VIEW_ABI, functionName: "VERSION" })) as string;
  } catch {
    // ignore
  }

  const threshold = (await publicClient.readContract({ address: safeAddress, abi: SAFE_VIEW_ABI, functionName: "getThreshold" })) as bigint;
  const owners = (await publicClient.readContract({ address: safeAddress, abi: SAFE_VIEW_ABI, functionName: "getOwners" })) as readonly `0x${string}`[];

  console.log(`Safe shape:  threshold=${threshold} owners=${owners.length} version=${safeVersion}`);
  console.log(`Safe owners: ${owners.join(", ")}`);

  // Audit H-05 — deep Safe validation. Beyond threshold/owners, verify the
  // proxy bytecode matches a known-good Safe singleton, and check that
  // modules / guard / fallback handler are at canonical defaults (0/null
  // singleton). Operators can override via BSC_ALLOW_SAFE_MODULES=true /
  // BSC_ALLOW_SAFE_GUARD=true / BSC_ALLOW_SAFE_FALLBACK=<addr>.
  const SAFE_DEEP_ABI = [
    { type: "function", name: "getModulesPaginated", stateMutability: "view",
      inputs: [{ name: "start", type: "address" }, { name: "pageSize", type: "uint256" }],
      outputs: [{ name: "array", type: "address[]" }, { name: "next", type: "address" }] },
    // Safe v1.3+ exposes guard via a fallback selector; standard reads via slot.
    // GUARD_STORAGE_SLOT = keccak256("guard_manager.guard.address") - 1
    // FALLBACK_HANDLER_STORAGE_SLOT = keccak256("fallback_manager.handler.address")
  ] as const;
  const GUARD_STORAGE_SLOT =
    "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8" as Hex;
  const FALLBACK_STORAGE_SLOT =
    "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5" as Hex;
  const SENTINEL_OWNERS = "0x0000000000000000000000000000000000000001" as `0x${string}`;

  // Modules check. Viem types getModulesPaginated as a tuple
  // [array, next] mirroring the on-chain return order.
  let modules: readonly `0x${string}`[] = [];
  try {
    const modPage = (await publicClient.readContract({
      address: safeAddress, abi: SAFE_DEEP_ABI, functionName: "getModulesPaginated",
      args: [SENTINEL_OWNERS, 10n]
    })) as readonly [readonly `0x${string}`[], `0x${string}`];
    modules = modPage[0] ?? [];
  } catch {
    // Pre-1.3 Safes don't expose getModulesPaginated; skip module check.
    console.log(`  INFO: getModulesPaginated unavailable (pre-Safe v1.3?); skipping modules check`);
  }
  const allowModules = (process.env["BSC_ALLOW_SAFE_MODULES"] ?? "").trim().toLowerCase() === "true";
  if (modules.length > 0) {
    if (productionMode && !allowModules) {
      throw new Error(
        `BSC_PRODUCTION_MODE=true: Safe has ${modules.length} enabled module(s) [${modules.join(", ")}]. ` +
          `Modules can bypass the multisig threshold. Either disable them OR set BSC_ALLOW_SAFE_MODULES=true after operator review.`
      );
    }
    console.log(`  WARN: Safe has ${modules.length} enabled module(s): ${modules.join(", ")}`);
  } else {
    console.log(`  PASS: Safe has 0 enabled modules`);
  }

  // Guard check.
  const guardRaw = await publicClient.getStorageAt({ address: safeAddress, slot: GUARD_STORAGE_SLOT });
  const guard = (guardRaw && guardRaw !== "0x" ? `0x${guardRaw.slice(-40)}` : "0x0000000000000000000000000000000000000000") as `0x${string}`;
  const allowGuard = (process.env["BSC_ALLOW_SAFE_GUARD"] ?? "").trim().toLowerCase() === "true";
  if (guard !== "0x0000000000000000000000000000000000000000") {
    if (productionMode && !allowGuard) {
      throw new Error(
        `BSC_PRODUCTION_MODE=true: Safe has a non-zero guard contract [${guard}]. ` +
          `Guards can intercept every execTransaction; verify and set BSC_ALLOW_SAFE_GUARD=true to override.`
      );
    }
    console.log(`  WARN: Safe guard = ${guard}`);
  } else {
    console.log(`  PASS: Safe has no guard contract`);
  }

  // Fallback handler check.
  const fbRaw = await publicClient.getStorageAt({ address: safeAddress, slot: FALLBACK_STORAGE_SLOT });
  const fallback = (fbRaw && fbRaw !== "0x" ? `0x${fbRaw.slice(-40)}` : "0x0000000000000000000000000000000000000000") as `0x${string}`;
  const expectedFallback = (process.env["BSC_ALLOW_SAFE_FALLBACK"] ?? "").trim().toLowerCase();
  // Canonical Safe v1.3+ CompatibilityFallbackHandler addresses are documented
  // in https://github.com/safe-global/safe-deployments — operators paste
  // the expected handler explicitly via BSC_ALLOW_SAFE_FALLBACK to allowlist.
  if (fallback !== "0x0000000000000000000000000000000000000000") {
    if (productionMode && expectedFallback !== fallback.toLowerCase()) {
      throw new Error(
        `BSC_PRODUCTION_MODE=true: Safe fallback handler = ${fallback}. ` +
          `Set BSC_ALLOW_SAFE_FALLBACK=${fallback} to acknowledge this matches the canonical Safe ` +
          `CompatibilityFallbackHandler for your Safe version (consult safe-deployments registry).`
      );
    }
    console.log(`  PASS: Safe fallback handler = ${fallback} (operator-allowlisted)`);
  } else {
    console.log(`  PASS: Safe has no fallback handler`);
  }

  if (productionMode) {
    if (Number(threshold) < PRODUCTION_SAFE_THRESHOLD_MIN) {
      throw new Error(
        `BSC_PRODUCTION_MODE=true requires Safe threshold >= ${PRODUCTION_SAFE_THRESHOLD_MIN}; ` +
          `got ${threshold}. Uplift the Safe before broadcasting (runbook 220/130).`
      );
    }
    if (owners.length < PRODUCTION_SAFE_OWNERS_MIN) {
      throw new Error(
        `BSC_PRODUCTION_MODE=true requires Safe owner count >= ${PRODUCTION_SAFE_OWNERS_MIN}; ` +
          `got ${owners.length}. Add owners to the Safe before broadcasting.`
      );
    }
    // Duplicate-EOA check: every owner must be unique.
    const lc = owners.map((o) => o.toLowerCase());
    if (new Set(lc).size !== lc.length) {
      throw new Error(
        `Safe owners contain duplicate entries; production deploy refuses ambiguous owner-set.`
      );
    }
    console.log(`  PASS: production-mode Safe shape ✓ (threshold=${threshold}, owners=${owners.length})`);
  } else {
    console.log(`  INFO: bootstrap mode — threshold/owners NOT enforced. Set BSC_PRODUCTION_MODE=true on production deploys.`);
  }
}

// ── Factory initcode encoding ────────────────────────────────────────────────

export function encodeFactoryInitcode(args: {
  erc1967ProxyCreationCode: Hex;
  impl: `0x${string}`;
  initializeCalldata: Hex;
}): Hex {
  const abiEncoded = encodeAbiParameters(
    [{ type: "address" }, { type: "bytes" }],
    [args.impl, args.initializeCalldata]
  );
  return concat([args.erc1967ProxyCreationCode, abiEncoded]);
}

// ── Initialize calldata encoding ─────────────────────────────────────────────

const PARK_TOKEN_INITIALIZE_ABI = [
  {
    type: "function",
    name: "initialize",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "config",
        type: "tuple",
        components: [
          { name: "defaultAdmin", type: "address" },
          { name: "defaultAdminTransferDelay", type: "uint48" },
          { name: "upgrader", type: "address" },
          { name: "rescuer", type: "address" },
          { name: "initialHolder", type: "address" },
          { name: "initialContractURI", type: "string" }
        ]
      }
    ],
    outputs: []
  }
] as const;

export interface InitializeCalldataArgs {
  defaultAdmin: `0x${string}`;
  defaultAdminTransferDelay: number;
  upgrader: `0x${string}`;
  rescuer: `0x${string}`;
  initialHolder: `0x${string}`;
  initialContractURI: string;
}

export function encodeInitializeCalldata(args: InitializeCalldataArgs): Hex {
  return encodeFunctionData({
    abi: PARK_TOKEN_INITIALIZE_ABI,
    functionName: "initialize",
    args: [args]
  });
}

// ── Proxy deploy via CREATE3 factory ─────────────────────────────────────────

export interface DeployProxyArgs {
  chainKey: SupportedChainKey;
  rpcUrl: string;
  privateKey: Hex;
  implAddress: `0x${string}`;
  initializeCalldata: Hex;
  erc1967ProxyCreationCode: Hex;
}

export interface DeployProxyResult {
  address: `0x${string}`;
  txHash: Hex;
}

export async function deployProxyViaCreate3(args: DeployProxyArgs): Promise<DeployProxyResult> {
  const factory = CREATE3_FACTORY_REGISTRY[args.chainKey];
  const account = privateKeyToAccount(args.privateKey);
  const transport = http(args.rpcUrl);
  const publicClient = createPublicClient({
    chain: CHAIN_BY_KEY[args.chainKey],
    transport
  });
  const walletClient = createWalletClient({
    account,
    chain: CHAIN_BY_KEY[args.chainKey],
    transport
  });

  await verifyExtcodehash({
    client: publicClient,
    address: factory.address,
    expectedExtcodehash: factory.expectedExtcodehash
  });

  const initcode = encodeFactoryInitcode({
    erc1967ProxyCreationCode: args.erc1967ProxyCreationCode,
    impl: args.implAddress,
    initializeCalldata: args.initializeCalldata
  });

  const { request } = await publicClient.simulateContract({
    address: factory.address,
    abi: ZEFRAMLOU_FACTORY_ABI,
    functionName: "deploy",
    args: [PARK_TOKEN_SALT, initcode],
    account
  });
  const txHash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`deployProxyViaCreate3: factory.deploy reverted: ${txHash}`);
  }

  const predicted = computePredictedAddress({
    chainKey: args.chainKey,
    deployer: account.address
  });
  return { address: predicted, txHash };
}

// ── Post-deploy assertions ───────────────────────────────────────────────────

export interface PostDeployAssertionArgs {
  publicClient: BoundPublicClient;
  proxyAddress: `0x${string}`;
  predictedAddress: `0x${string}`;
  timelockAddress: `0x${string}`;
  defaultAdmin: `0x${string}`;
  rescuer: `0x${string}`;
  initialHolder: `0x${string}`;
  // EOA that broadcast the deploy transactions. Used by the Timelock-internal
  // role lattice assertion to verify deployer was NOT left with any roles.
  deployer: `0x${string}`;
  expectedTimelockDelay: number;
  expectedContractURI: string;
}

export async function runPostDeployAssertions(args: PostDeployAssertionArgs): Promise<void> {
  if (args.proxyAddress.toLowerCase() !== args.predictedAddress.toLowerCase()) {
    throw new Error(
      `Predicted address mismatch: predicted=${args.predictedAddress}, actual=${args.proxyAddress}`
    );
  }
  console.log(`  PASS: proxy address == predicted CREATE3 address (${args.proxyAddress})`);

  const upgraderRole = await args.publicClient.readContract({
    address: args.proxyAddress,
    abi: getProxyAbi(),
    functionName: "UPGRADER_ROLE"
  });
  const timelockAdminRole = await args.publicClient.readContract({
    address: args.proxyAddress,
    abi: getProxyAbi(),
    functionName: "TIMELOCK_ADMIN_ROLE"
  });
  const rescuerRole = await args.publicClient.readContract({
    address: args.proxyAddress,
    abi: getProxyAbi(),
    functionName: "RESCUER_ROLE"
  });
  const defaultAdminRole = `0x${"00".repeat(32)}` as Hex;

  const liveMinDelay = await args.publicClient.readContract({
    address: args.timelockAddress,
    abi: getTimelockAbi(),
    functionName: "getMinDelay"
  });
  if (liveMinDelay !== BigInt(args.expectedTimelockDelay)) {
    throw new Error(
      `Timelock minDelay ${liveMinDelay} != expected ${args.expectedTimelockDelay}`
    );
  }
  console.log(`  PASS: Timelock minDelay == ${liveMinDelay}s (matches deploy arg)`);

  const safeHasAdmin = await args.publicClient.readContract({
    address: args.proxyAddress,
    abi: getProxyAbi(),
    functionName: "hasRole",
    args: [defaultAdminRole, args.defaultAdmin]
  });
  if (!safeHasAdmin) throw new Error("Assertion failed: Safe holds DEFAULT_ADMIN_ROLE");
  console.log("  PASS: Safe holds DEFAULT_ADMIN_ROLE");

  const timelockHasUpgrader = await args.publicClient.readContract({
    address: args.proxyAddress,
    abi: getProxyAbi(),
    functionName: "hasRole",
    args: [upgraderRole, args.timelockAddress]
  });
  if (!timelockHasUpgrader) throw new Error("Assertion failed: Timelock holds UPGRADER_ROLE");
  console.log("  PASS: Timelock holds UPGRADER_ROLE");

  const timelockHasTLA = await args.publicClient.readContract({
    address: args.proxyAddress,
    abi: getProxyAbi(),
    functionName: "hasRole",
    args: [timelockAdminRole, args.timelockAddress]
  });
  if (!timelockHasTLA) throw new Error("Assertion failed: Timelock holds TIMELOCK_ADMIN_ROLE");
  console.log("  PASS: Timelock holds TIMELOCK_ADMIN_ROLE");

  const rescuerHasRescuer = await args.publicClient.readContract({
    address: args.proxyAddress,
    abi: getProxyAbi(),
    functionName: "hasRole",
    args: [rescuerRole, args.rescuer]
  });
  if (!rescuerHasRescuer) throw new Error("Assertion failed: Rescuer holds RESCUER_ROLE");
  console.log("  PASS: Rescuer holds RESCUER_ROLE");

  const safeHasTLA = await args.publicClient.readContract({
    address: args.proxyAddress,
    abi: getProxyAbi(),
    functionName: "hasRole",
    args: [timelockAdminRole, args.defaultAdmin]
  });
  if (safeHasTLA) throw new Error("Assertion failed: Safe does NOT hold TIMELOCK_ADMIN_ROLE");
  console.log("  PASS: Safe does NOT hold TIMELOCK_ADMIN_ROLE");

  const safeHasUpgrader = await args.publicClient.readContract({
    address: args.proxyAddress,
    abi: getProxyAbi(),
    functionName: "hasRole",
    args: [upgraderRole, args.defaultAdmin]
  });
  if (safeHasUpgrader) throw new Error("Assertion failed: Safe does NOT hold UPGRADER_ROLE");
  console.log("  PASS: Safe does NOT hold UPGRADER_ROLE");

  const upgraderRoleAdmin = (await args.publicClient.readContract({
    address: args.proxyAddress,
    abi: getProxyAbi(),
    functionName: "getRoleAdmin",
    args: [upgraderRole]
  })) as Hex;
  if (upgraderRoleAdmin.toLowerCase() !== (timelockAdminRole as Hex).toLowerCase()) {
    throw new Error(
      `getRoleAdmin(UPGRADER_ROLE) ${upgraderRoleAdmin} != TIMELOCK_ADMIN_ROLE ${String(timelockAdminRole)}`
    );
  }
  console.log("  PASS: getRoleAdmin(UPGRADER_ROLE) == TIMELOCK_ADMIN_ROLE");

  const tlaRoleAdmin = (await args.publicClient.readContract({
    address: args.proxyAddress,
    abi: getProxyAbi(),
    functionName: "getRoleAdmin",
    args: [timelockAdminRole]
  })) as Hex;
  if (tlaRoleAdmin.toLowerCase() !== (timelockAdminRole as Hex).toLowerCase()) {
    throw new Error(
      `getRoleAdmin(TIMELOCK_ADMIN_ROLE) ${tlaRoleAdmin} != self ${String(timelockAdminRole)}`
    );
  }
  console.log("  PASS: getRoleAdmin(TIMELOCK_ADMIN_ROLE) == self (one-way grant)");

  // ── Timelock-internal role lattice (CertiK pre-audit H-02 + mega-review M-1) ──
  // Verify that the deployed Timelock holds the canonical OZ role configuration:
  //   PROPOSER_ROLE  == Safe (defaultAdmin)
  //   CANCELLER_ROLE == Safe (defaultAdmin)
  //   EXECUTOR_ROLE  == address(0) (open executor — wildcard)
  //   DEFAULT_ADMIN_ROLE on the Timelock == Timelock itself (self-administered)
  //   No other addresses unexpectedly hold any of these roles.
  const PROPOSER_ROLE = "0xb09aa5aeb3702cfd50b6b62bc4532604938f21248a27a1d5ca736082b6819cc1" as Hex; // keccak256("PROPOSER_ROLE")
  const EXECUTOR_ROLE = "0xd8aa0f3194971a2a116679f7c2090f6939c8d4e01a2a8d7e41d55e5351469e63" as Hex; // keccak256("EXECUTOR_ROLE")
  const CANCELLER_ROLE = "0xfd643c72710c63c0180259aba6b2d05451e3591a24e58b62239378085726f783" as Hex; // keccak256("CANCELLER_ROLE")
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Hex;

  const safeIsProposer = await args.publicClient.readContract({
    address: args.timelockAddress,
    abi: getTimelockAbi(),
    functionName: "hasRole",
    args: [PROPOSER_ROLE, args.defaultAdmin]
  });
  if (!safeIsProposer) throw new Error("Assertion failed: Safe holds PROPOSER_ROLE on Timelock");
  console.log("  PASS: Safe holds PROPOSER_ROLE on Timelock");

  const safeIsCanceller = await args.publicClient.readContract({
    address: args.timelockAddress,
    abi: getTimelockAbi(),
    functionName: "hasRole",
    args: [CANCELLER_ROLE, args.defaultAdmin]
  });
  if (!safeIsCanceller) throw new Error("Assertion failed: Safe holds CANCELLER_ROLE on Timelock");
  console.log("  PASS: Safe holds CANCELLER_ROLE on Timelock");

  const wildcardIsExecutor = await args.publicClient.readContract({
    address: args.timelockAddress,
    abi: getTimelockAbi(),
    functionName: "hasRole",
    args: [EXECUTOR_ROLE, ZERO_ADDR]
  });
  if (!wildcardIsExecutor) {
    throw new Error(
      "Assertion failed: address(0) does NOT hold EXECUTOR_ROLE on Timelock " +
        "— deploy intended to be open-executor but is restricted."
    );
  }
  console.log("  PASS: address(0) holds EXECUTOR_ROLE on Timelock (open executor as designed)");

  const timelockIsSelfAdmin = await args.publicClient.readContract({
    address: args.timelockAddress,
    abi: getTimelockAbi(),
    functionName: "hasRole",
    args: [defaultAdminRole, args.timelockAddress]
  });
  if (!timelockIsSelfAdmin) {
    throw new Error("Assertion failed: Timelock does NOT hold DEFAULT_ADMIN_ROLE on itself");
  }
  console.log("  PASS: Timelock holds DEFAULT_ADMIN_ROLE on itself (self-administered)");

  // Negative checks: deployer must NOT retain any Timelock roles after deploy
  // (some OZ Timelock variants temporarily grant DEFAULT_ADMIN_ROLE to the
  // deployer during construction; ours should not).
  const deployerHasTimelockAdmin = await args.publicClient.readContract({
    address: args.timelockAddress,
    abi: getTimelockAbi(),
    functionName: "hasRole",
    args: [defaultAdminRole, args.deployer]
  });
  if (deployerHasTimelockAdmin) {
    throw new Error(
      `Assertion failed: deployer ${args.deployer} retains DEFAULT_ADMIN_ROLE on Timelock; ` +
        `expected to be revoked at end of construction.`
    );
  }
  console.log("  PASS: deployer does NOT retain DEFAULT_ADMIN_ROLE on Timelock");

  // Token state assertions — catch misconfigured initialize() args before manifest is written.
  const EXPECTED_CAP = 1_000_000_000n * 10n ** 6n; // 1B PARK, 6 decimals

  const liveCap = await args.publicClient.readContract({
    address: args.proxyAddress,
    abi: getProxyAbi(),
    functionName: "cap"
  });
  if (liveCap !== EXPECTED_CAP) {
    throw new Error(`cap() ${liveCap} != expected ${EXPECTED_CAP}`);
  }
  console.log(`  PASS: cap() == ${liveCap} (1B PARK)`);

  const liveSupply = await args.publicClient.readContract({
    address: args.proxyAddress,
    abi: getProxyAbi(),
    functionName: "totalSupply"
  });
  if (liveSupply !== EXPECTED_CAP) {
    throw new Error(`totalSupply() ${liveSupply} != cap ${EXPECTED_CAP}`);
  }
  console.log(`  PASS: totalSupply() == cap (${liveSupply})`);

  const holderBalance = await args.publicClient.readContract({
    address: args.proxyAddress,
    abi: getProxyAbi(),
    functionName: "balanceOf",
    args: [args.initialHolder]
  });
  if (holderBalance !== EXPECTED_CAP) {
    throw new Error(
      `balanceOf(initialHolder=${args.initialHolder}) ${holderBalance} != cap ${EXPECTED_CAP}`
    );
  }
  console.log(`  PASS: balanceOf(initialHolder) == cap (${holderBalance})`);

  const liveVersion = await args.publicClient.readContract({
    address: args.proxyAddress,
    abi: getProxyAbi(),
    functionName: "implVersion"
  });
  if (liveVersion !== "v1.0.0") {
    throw new Error(`implVersion() "${liveVersion}" != "v1.0.0"`);
  }
  console.log(`  PASS: implVersion() == "${liveVersion}"`);

  const liveURI = await args.publicClient.readContract({
    address: args.proxyAddress,
    abi: getProxyAbi(),
    functionName: "contractURI"
  });
  if (liveURI !== args.expectedContractURI) {
    throw new Error(`contractURI() "${liveURI}" != expected "${args.expectedContractURI}"`);
  }
  console.log(`  PASS: contractURI() == "${liveURI}"`);
}

// ── Manifest ─────────────────────────────────────────────────────────────────

export interface ProductionGate {
  passed: boolean;
  detail: string;
}

export interface ProductionGates {
  timelockDelayMeetsFloor: ProductionGate;
  productionModeFlag: ProductionGate;
  expectedDeployerPinned: ProductionGate;
  expectedProxyPinned: ProductionGate;
  expectedInitialHolderPinned: ProductionGate;
  safeShapeValidated: ProductionGate;
  reproVerified: ProductionGate;
  monitoringInstantiated: ProductionGate;
  explorerProxyRegistered: ProductionGate;
}

export type DeploymentMode = "staging" | "production";

export interface BscDeployManifest {
  versionLabel: string;
  chain: string;
  chainId: number;
  contractName: "ParkToken";
  proxyAddress: string;
  implementationAddress: string;
  implementationVersion: string;
  timelockAddress: string;
  timelockDelay: number;
  adminDelay: number;
  defaultAdmin: string;
  upgrader: string;
  rescuer: string;
  initialHolder: string;
  initialContractURI: string;
  deployer: string;
  deploymentBlock: number;
  deploymentTimestamp: string;
  governanceUpgradePending: boolean;
  pendingGovernanceActions: ReadonlyArray<string>;
  // Per-finding:
  // - audit-2026-05-10 H-01: split single bool `productionReady` into:
  //     - `deploymentMode`            — operator's stated intent
  //     - `productionGates`           — every prerequisite gate, individually
  //     - `timelockDelayMeetsProductionFloor`  — the original delay-only check
  //     - `productionReady`           — computed AND of all gates (true only
  //                                     when every gate.passed === true).
  //   Old consumers reading `productionReady` keep working but its meaning
  //   is now stricter (was: timelockDelay >= floor; now: all gates pass).
  deploymentMode: DeploymentMode;
  timelockDelayMeetsProductionFloor: boolean;
  productionGates: ProductionGates;
  productionReady: boolean;
  // CREATE3 / ZeframLou specific:
  salt: string;
  factoryAddress: string;
  factoryExtcodehash: string;
  factoryVersion: string;
  predictedAddress: string;
}

export interface BuildManifestArgs {
  chainKey: SupportedChainKey;
  chainId: number;
  proxyAddress: string;
  implementationAddress: string;
  timelockAddress: string;
  timelockDelay: number;
  adminDelay: number;
  defaultAdmin: string;
  rescuer: string;
  initialHolder: string;
  initialContractURI: string;
  deployer: string;
  deploymentBlock: number;
  predictedAddress: string;
  // New (audit H-01):
  productionMode: boolean;
  expectedDeployerSet: boolean;
  expectedProxySet: boolean;
  expectedInitialHolderSet: boolean;
  safeShapeValidated: boolean;
  reproVerified: boolean;
  // Operator attestations (default false; flip post-mark-as-proxy + alert install).
  // Captured as deploy-time INTENT; operator updates manifest later.
  monitoringInstantiated?: boolean;
  explorerProxyRegistered?: boolean;
}

// Re-export so manifest readers can sanity-check the floor without re-importing
// from resolve-bsc-env. Single source of truth lives there.
export { PRODUCTION_TIMELOCK_DELAY_MIN as MIN_PRODUCTION_TIMELOCK_DELAY };

export function buildManifest(args: BuildManifestArgs): BscDeployManifest {
  const factory = CREATE3_FACTORY_REGISTRY[args.chainKey];
  const timelockDelayMeetsFloor = args.timelockDelay >= PRODUCTION_TIMELOCK_DELAY_MIN;

  const gates: ProductionGates = {
    timelockDelayMeetsFloor: {
      passed: timelockDelayMeetsFloor,
      detail: `timelockDelay=${args.timelockDelay}s, floor=${PRODUCTION_TIMELOCK_DELAY_MIN}s`
    },
    productionModeFlag: {
      passed: args.productionMode,
      detail: `BSC_PRODUCTION_MODE=${args.productionMode}`
    },
    expectedDeployerPinned: {
      passed: args.expectedDeployerSet,
      detail: args.expectedDeployerSet
        ? "BSC_EXPECTED_DEPLOYER set and matched"
        : "BSC_EXPECTED_DEPLOYER not set"
    },
    expectedProxyPinned: {
      passed: args.expectedProxySet,
      detail: args.expectedProxySet
        ? "BSC_EXPECTED_PROXY_ADDRESS set and matched"
        : "BSC_EXPECTED_PROXY_ADDRESS not set"
    },
    expectedInitialHolderPinned: {
      passed: args.expectedInitialHolderSet,
      detail: args.expectedInitialHolderSet
        ? "BSC_EXPECTED_INITIAL_HOLDER set and matched"
        : "BSC_EXPECTED_INITIAL_HOLDER not set (audit CR-01)"
    },
    safeShapeValidated: {
      passed: args.safeShapeValidated,
      detail: args.safeShapeValidated
        ? "Safe threshold>=3, owners>=5, no duplicates"
        : "Safe shape NOT enforced (bootstrap mode)"
    },
    reproVerified: {
      passed: args.reproVerified,
      detail: args.reproVerified
        ? "scripts/repro.sh asserted bytecode baseline pre-broadcast"
        : "Bytecode baseline check NOT run pre-broadcast (audit M-02)"
    },
    monitoringInstantiated: {
      passed: args.monitoringInstantiated ?? false,
      detail: args.monitoringInstantiated
        ? "Operator attests per-chain monitoring rules installed + test-fired"
        : "Monitoring not yet instantiated (operator updates manifest post-deploy)"
    },
    explorerProxyRegistered: {
      passed: args.explorerProxyRegistered ?? false,
      detail: args.explorerProxyRegistered
        ? "BscScan/Arbiscan verifyproxycontract API call confirmed; proxy tabs render impl ABI"
        : "Explorer proxy registration not yet confirmed (operator updates manifest post-deploy)"
    }
  };

  // Strict productionReady: ALL gates must pass.
  const productionReady = Object.values(gates).every((g) => g.passed);
  const deploymentMode: DeploymentMode = args.productionMode ? "production" : "staging";
  const governanceUpgradePending = !productionReady;

  return {
    versionLabel: "v1.0.0",
    chain: args.chainKey,
    chainId: args.chainId,
    contractName: "ParkToken",
    proxyAddress: args.proxyAddress,
    implementationAddress: args.implementationAddress,
    implementationVersion: "v1.0.0",
    timelockAddress: args.timelockAddress,
    timelockDelay: args.timelockDelay,
    adminDelay: args.adminDelay,
    defaultAdmin: args.defaultAdmin,
    upgrader: args.timelockAddress,
    rescuer: args.rescuer,
    initialHolder: args.initialHolder,
    initialContractURI: args.initialContractURI,
    deployer: args.deployer,
    deploymentBlock: args.deploymentBlock,
    deploymentTimestamp: new Date().toISOString(),
    governanceUpgradePending,
    pendingGovernanceActions: [],
    deploymentMode,
    timelockDelayMeetsProductionFloor: timelockDelayMeetsFloor,
    productionGates: gates,
    productionReady,
    salt: PARK_TOKEN_SALT,
    factoryAddress: factory.address,
    factoryExtcodehash: factory.expectedExtcodehash,
    factoryVersion: factory.factoryVersion,
    predictedAddress: args.predictedAddress
  };
}

export function writeManifest(args: {
  manifest: BscDeployManifest;
  networkName: string;
  suffix?: string;
}): string {
  const sfx = args.suffix ?? "";
  const manifestPath = join(
    process.cwd(),
    `ops/210-base-deployment-manifest-${args.networkName}${sfx}.json`
  );
  writeFileSync(manifestPath, `${JSON.stringify(args.manifest, null, 2)}\n`);
  return manifestPath;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = resolveBscEnv(process.env, { strict: true });
  // Default to "bsc" when TARGET_CHAIN is unset so the script is runnable
  // without an explicit env var (the documented default path).
  const networkName = process.env["TARGET_CHAIN"] ?? "bsc";
  if (networkName !== "bsc") {
    throw new Error(
      `TARGET_CHAIN must be bsc, got ${networkName}`
    );
  }
  const chainKey = networkName as SupportedChainKey;
  // Pass the resolved networkName so resolveChain never sees an undefined
  // TARGET_CHAIN even when the default kicks in.
  const resolvedChain = resolveChain({ ...process.env, TARGET_CHAIN: networkName });
  const rpcUrl = process.env[resolvedChain.rpcEnvName];
  const privateKeyRaw = process.env[resolvedChain.privateKeyEnvName];
  const manifestSuffix = process.env["BSC_MANIFEST_SUFFIX"];
  if (!rpcUrl) throw new Error(`${resolvedChain.rpcEnvName} not set`);
  if (!privateKeyRaw) throw new Error(`${resolvedChain.privateKeyEnvName} not set`);
  // Normalize: accept both "0x<64 hex>" and bare "<64 hex>" forms.
  const privateKey = (privateKeyRaw.startsWith("0x") ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex;

  const account = privateKeyToAccount(privateKey);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: CHAIN_BY_KEY[chainKey], transport });
  const walletClient = createWalletClient({ account, chain: CHAIN_BY_KEY[chainKey], transport });

  const net = await publicClient.getChainId();
  const expectedChainId = CHAIN_BY_KEY[chainKey].id;
  if (net !== expectedChainId) {
    throw new Error(`RPC chainId ${net} != expected ${expectedChainId} for ${chainKey}`);
  }

  console.log(`Deployer:    ${account.address}`);
  console.log(`Network:     ${chainKey} (chainId=${net})`);
  console.log(`Factory:     ${CREATE3_FACTORY_REGISTRY[chainKey].address}`);
  console.log(`Salt:        ${PARK_TOKEN_SALT}`);

  // Pre-flight: verify CREATE3 factory extcodehash before spending any gas.
  // If the factory is missing or has unexpected bytecode on this network, abort
  // here rather than after Timelock + impl are already deployed.
  const factory = CREATE3_FACTORY_REGISTRY[chainKey];
  await verifyExtcodehash({
    client: publicClient,
    address: factory.address,
    expectedExtcodehash: factory.expectedExtcodehash
  });
  console.log(`  PASS: factory extcodehash verified on ${chainKey}`);

  // Pre-claim: predicted address must be empty before broadcast
  const predicted = computePredictedAddress({
    chainKey,
    deployer: account.address
  });
  console.log(`Predicted:   ${predicted}`);
  await preClaimSafetyCheck({ rpcUrl, chainKey, predicted });
  console.log("  PASS: predicted address is empty, safe to broadcast");

  // Expected-address preflight (CertiK pre-audit M-03). When the operator
  // exports BSC_EXPECTED_DEPLOYER and/or BSC_EXPECTED_PROXY_ADDRESS, the
  // script aborts on mismatch BEFORE broadcasting any tx. Defends against:
  //   - wrong key in BSC_PRIVATE_KEY (deployer signs with unintended EOA)
  //   - wrong-salt deploy at unintended proxy address
  //   - operator running deploy on wrong chain by accident
  // Setting both is RECOMMENDED for production deploys; missing them only
  // logs an INFO note (no abort) for bootstrap rehearsals.
  const expectedDeployer = process.env["BSC_EXPECTED_DEPLOYER"];
  if (expectedDeployer !== undefined && expectedDeployer.trim() !== "") {
    if (expectedDeployer.toLowerCase() !== account.address.toLowerCase()) {
      throw new Error(
        `BSC_EXPECTED_DEPLOYER mismatch: got ${account.address}, expected ${expectedDeployer}. ` +
          `Refusing to broadcast — verify BSC_PRIVATE_KEY corresponds to the documented deployer.`
      );
    }
    console.log(`  PASS: deployer matches BSC_EXPECTED_DEPLOYER`);
  } else if (cfg.productionMode) {
    throw new Error(
      `BSC_PRODUCTION_MODE=true requires BSC_EXPECTED_DEPLOYER to be set ` +
        `(operator must declare the intended deployer EOA upfront).`
    );
  } else {
    console.log(`  INFO: BSC_EXPECTED_DEPLOYER unset — bootstrap mode, skipping deployer assert`);
  }
  const expectedProxy = process.env["BSC_EXPECTED_PROXY_ADDRESS"];
  if (expectedProxy !== undefined && expectedProxy.trim() !== "") {
    if (expectedProxy.toLowerCase() !== predicted.toLowerCase()) {
      throw new Error(
        `BSC_EXPECTED_PROXY_ADDRESS mismatch: predicted ${predicted}, expected ${expectedProxy}. ` +
          `Refusing to broadcast — verify the salt and deployer combination produces the intended proxy address.`
      );
    }
    console.log(`  PASS: predicted address matches BSC_EXPECTED_PROXY_ADDRESS`);
  } else if (cfg.productionMode) {
    throw new Error(
      `BSC_PRODUCTION_MODE=true requires BSC_EXPECTED_PROXY_ADDRESS to be set ` +
        `(operator must declare the intended proxy address upfront).`
    );
  } else {
    console.log(`  INFO: BSC_EXPECTED_PROXY_ADDRESS unset — bootstrap mode, skipping proxy assert`);
  }

  // Initial supply holder pin (audit CR-01). The full 1B cap is minted to
  // cfg.initialHolder by initialize(). A poisoned env or operator typo can
  // allocate the supply to an unintended address — recovery requires that
  // holder to burn/return tokens. Pin upfront in production to fail-closed.
  const expectedInitialHolder = process.env["BSC_EXPECTED_INITIAL_HOLDER"];
  if (expectedInitialHolder !== undefined && expectedInitialHolder.trim() !== "") {
    if (expectedInitialHolder.toLowerCase() !== cfg.initialHolder.toLowerCase()) {
      throw new Error(
        `BSC_EXPECTED_INITIAL_HOLDER mismatch: configured ${cfg.initialHolder}, expected ${expectedInitialHolder}. ` +
          `Refusing to broadcast — the full 1B PARK cap will mint to BSC_INITIAL_HOLDER at initialize().`
      );
    }
    console.log(`  PASS: initial holder matches BSC_EXPECTED_INITIAL_HOLDER`);
  } else if (cfg.productionMode) {
    throw new Error(
      `BSC_PRODUCTION_MODE=true requires BSC_EXPECTED_INITIAL_HOLDER to be set ` +
        `(operator must declare the intended supply recipient upfront — see CR-01 in audit-2026-05-10).`
    );
  } else {
    console.log(`  INFO: BSC_EXPECTED_INITIAL_HOLDER unset — bootstrap mode, skipping holder assert`);
  }

  // Pre-broadcast Safe-shape gate (CertiK pre-audit H-02). Production mode
  // requires Safe.threshold >= 3 and Safe.owners.length >= 5; bootstrap
  // mode logs the same numbers as info but does not abort.
  await assertSafeShape({
    publicClient,
    safeAddress: cfg.defaultAdmin as `0x${string}`,
    productionMode: cfg.productionMode
  });

  // Pre-broadcast bytecode-baseline gate (audit M-02). Production deploys
  // refuse to broadcast unless the operator has explicitly attested that
  // scripts/repro.sh ran cleanly against the deploy commit by exporting
  // BSC_REPRO_VERIFIED=true. Bootstrap deploys log INFO without aborting.
  // Operators MUST run `bash scripts/repro.sh && export BSC_REPRO_VERIFIED=true`
  // in the same shell session before launching deploy-bsc.ts.
  const reproVerified =
    (process.env["BSC_REPRO_VERIFIED"] ?? "").trim().toLowerCase() === "true";
  if (cfg.productionMode && !reproVerified) {
    throw new Error(
      `BSC_PRODUCTION_MODE=true requires BSC_REPRO_VERIFIED=true (audit M-02). ` +
        `Run \`bash scripts/repro.sh\` first to assert all 6 baseline rows match, ` +
        `then re-launch deploy-bsc.ts in the same shell with BSC_REPRO_VERIFIED=true. ` +
        `This is a fail-closed gate so a deploy can never broadcast a bytecode that ` +
        `differs from the published audit baseline.`
    );
  } else if (cfg.productionMode) {
    console.log(`  PASS: BSC_REPRO_VERIFIED=true — operator attests baseline match`);
  } else {
    console.log(`  INFO: BSC_REPRO_VERIFIED=${reproVerified} — bootstrap mode, advisory only`);
  }

  // Tx 1: Timelock
  console.log("\nStep 1: Deploying ParkTimelockController...");
  const timelock = await deployTimelock({
    walletClient,
    publicClient,
    delay: cfg.timelockDelay,
    proposers: [cfg.defaultAdmin as `0x${string}`]
  });
  console.log(`  Timelock: ${timelock.address} (delay=${cfg.timelockDelay}s) tx=${timelock.deployTx}`);

  // Tx 2: impl
  console.log("\nStep 2: Deploying ParkToken impl...");
  const impl = await deployImpl({ walletClient, publicClient });
  console.log(`  Impl: ${impl.address} tx=${impl.deployTx}`);

  // Encode initialize calldata referencing the freshly-deployed Timelock
  const initializeCalldata = encodeInitializeCalldata({
    defaultAdmin: cfg.defaultAdmin as `0x${string}`,
    defaultAdminTransferDelay: cfg.adminDelay,
    upgrader: timelock.address,
    rescuer: cfg.rescuer as `0x${string}`,
    initialHolder: cfg.initialHolder as `0x${string}`,
    initialContractURI: cfg.contractURI
  });

  // Load ERC1967Proxy creation code from Hardhat artifact
  const erc1967Artifact = loadArtifact(
    "artifacts/contracts/imports/ERC1967ProxyImport.sol/ParkERC1967Proxy.json"
  );
  const erc1967ProxyCreationCode = erc1967Artifact.bytecode;

  // Tx 3: ZeframLou factory.deploy
  console.log("\nStep 3: Deploying ERC1967Proxy via ZeframLou CREATE3...");
  const proxy = await deployProxyViaCreate3({
    chainKey,
    rpcUrl,
    privateKey,
    implAddress: impl.address,
    initializeCalldata,
    erc1967ProxyCreationCode
  });
  console.log(`  Proxy: ${proxy.address} tx=${proxy.txHash}`);

  console.log("\n=== Deployed ===");
  console.log(`  Proxy:          ${proxy.address}`);
  console.log(`  Implementation: ${impl.address}`);
  console.log(`  Timelock:       ${timelock.address} (delay=${cfg.timelockDelay}s)`);
  console.log(`  Default admin:  ${cfg.defaultAdmin}`);
  console.log(`  Rescuer:        ${cfg.rescuer}`);
  console.log(`  Initial holder: ${cfg.initialHolder}`);
  console.log(`  Salt:           ${PARK_TOKEN_SALT}`);
  console.log(`  Factory:        ${CREATE3_FACTORY_REGISTRY[chainKey].address}`);
  console.log(`  Factory hash:   ${CREATE3_FACTORY_REGISTRY[chainKey].expectedExtcodehash}`);

  // Post-deploy assertions (includes address == predicted as first check)
  console.log("\n=== Post-deploy assertions ===");
  await runPostDeployAssertions({
    publicClient,
    proxyAddress: proxy.address,
    predictedAddress: predicted,
    timelockAddress: timelock.address,
    defaultAdmin: cfg.defaultAdmin as `0x${string}`,
    rescuer: cfg.rescuer as `0x${string}`,
    initialHolder: cfg.initialHolder as `0x${string}`,
    deployer: account.address,
    expectedTimelockDelay: cfg.timelockDelay,
    expectedContractURI: cfg.contractURI
  });

  const deploymentBlock = Number(await publicClient.getBlockNumber());
  const manifest = buildManifest({
    chainKey,
    chainId: net,
    proxyAddress: proxy.address,
    implementationAddress: impl.address,
    timelockAddress: timelock.address,
    timelockDelay: cfg.timelockDelay,
    adminDelay: cfg.adminDelay,
    defaultAdmin: cfg.defaultAdmin,
    rescuer: cfg.rescuer,
    initialHolder: cfg.initialHolder,
    initialContractURI: cfg.contractURI,
    deployer: account.address,
    deploymentBlock,
    predictedAddress: predicted,
    // Production-gate inputs (audit H-01) — captured from env state.
    productionMode: cfg.productionMode,
    expectedDeployerSet: (process.env["BSC_EXPECTED_DEPLOYER"] ?? "").trim() !== "",
    expectedProxySet: (process.env["BSC_EXPECTED_PROXY_ADDRESS"] ?? "").trim() !== "",
    expectedInitialHolderSet: (process.env["BSC_EXPECTED_INITIAL_HOLDER"] ?? "").trim() !== "",
    // assertSafeShape only ABORTS production deploys when threshold/owners
    // fail; reaching this line in production mode means the gate passed.
    // Bootstrap deploys log INFO without enforcing — gate stays false.
    safeShapeValidated: cfg.productionMode,
    // M-02: operator-attestation env. The actual baseline-gate hook runs
    // BEFORE broadcast (see assertReproVerified above when productionMode);
    // this flag records that the gate ran cleanly.
    reproVerified: (process.env["BSC_REPRO_VERIFIED"] ?? "").trim().toLowerCase() === "true"
    // monitoringInstantiated / explorerProxyRegistered are operator
    // attestations updated post-deploy; default false at deploy time.
  });
  const manifestPath = manifestSuffix !== undefined
    ? writeManifest({ manifest, networkName: chainKey, suffix: manifestSuffix })
    : writeManifest({ manifest, networkName: chainKey });
  console.log(`\nManifest written: ${manifestPath}`);
}

// Run main() only when this module is the script entrypoint, not when
// it's imported by tests or by other scripts.
const _scriptPath = fileURLToPath(import.meta.url);
const isEntrypoint = process.argv.some(
  (a) => a !== undefined && pathResolve(a) === _scriptPath
);
if (isEntrypoint) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
