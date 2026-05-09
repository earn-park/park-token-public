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
import { resolveBscEnv, type ResolvedBscEnv } from "./resolve-bsc-env.js";

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
    _timelockAbi = extractAbiFragments(full, ["getMinDelay"]);
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
}

// Minimum timelockDelay (seconds) to be considered production-ready.
// 6 hours gives the community a meaningful reaction window for any scheduled upgrade.
const MIN_PRODUCTION_TIMELOCK_DELAY = 21600;

export function buildManifest(args: BuildManifestArgs): BscDeployManifest {
  const factory = CREATE3_FACTORY_REGISTRY[args.chainKey];
  const productionReady = args.timelockDelay >= MIN_PRODUCTION_TIMELOCK_DELAY;
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
    predictedAddress: predicted
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
