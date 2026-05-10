// ParkToken BSC — Safe calldata + ABI artefact builder.
//
// Produces machine-readable artefacts that the Safe operator (or the audit
// firm) can use to verify the deployment payload before signing.
//
// Outputs (in `ops/`):
//   - `210-base-init-calldata-<network>.json` — the InitConfig struct + the
//     hex-encoded `initialize(InitConfig)` calldata + CREATE3 metadata.
//   - `210-base-abi.json` — minimal ABI subset for monitoring.
//
// This script does NOT broadcast. Pure offline calldata generation.
// Runtime: pure viem — no ethers, no Hardhat runtime.
//
// Environment variables (mirror deploy-bsc.ts):
//   BSC_DEFAULT_ADMIN_ADDRESS  — Safe address
//   BSC_UPGRADER_ADDRESS       — deployed Timelock address (optional pre-deploy)
//   BSC_RESCUER_ADDRESS        — REQUIRED, must differ from defaultAdmin
//   BSC_INITIAL_HOLDER         — defaults to BSC_DEFAULT_ADMIN_ADDRESS
//   BSC_TIMELOCK_DELAY_SECONDS — must be ≥ 60s (production target 21600s)
//   BSC_DEFAULT_ADMIN_TRANSFER_DELAY_SECONDS — [86400, 2592000]
//   BSC_CONTRACT_URI           — defaults to earnpark.com URI
//   BSC_DEPLOYER_ADDRESS       — optional, used to compute predictedAddress
//   TARGET_CHAIN               — bsc (defaults to bsc)

import "dotenv/config";
import {readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {encodeFunctionData, type Hex} from "viem";
import {
  PARK_TOKEN_SALT,
  CREATE3_FACTORY_REGISTRY,
  computeProxyAddress,
  type SupportedChainKey
} from "./create3-factory.js";
import {resolveBscEnv} from "./resolve-bsc-env.js";

// The function selector for initialize((address,uint48,address,address,address,string)).
// Computed from the first 4 bytes of the encoded calldata.
function getSelector(calldata: Hex): string {
  return calldata.slice(0, 10);
}

// ── Artifact ABI loader ──────────────────────────────────────────────────────

interface AbiFragment {
  type: string;
  name?: string;
  inputs?: unknown[];
  outputs?: unknown[];
  stateMutability?: string;
}

function loadAbi(relativePath: string): AbiFragment[] {
  const fullPath = join(process.cwd(), relativePath);
  const raw = JSON.parse(readFileSync(fullPath, "utf-8")) as {abi: AbiFragment[]};
  return raw.abi;
}

// Extract the `initialize` fragment from the compiled ParkToken artifact.
// This avoids duplicating the ABI — single source of truth is the artifact.
function getInitializeAbi(): AbiFragment[] {
  const full = loadAbi("artifacts/contracts/ParkToken.sol/ParkToken.json");
  const fragment = full.find((f) => f.type === "function" && f.name === "initialize");
  if (!fragment) {
    throw new Error(
      "initialize fragment not found in ParkToken artifact — run npx hardhat compile"
    );
  }
  return [fragment];
}

interface ResolvedConfig {
  defaultAdmin: string;
  defaultAdminTransferDelay: number;
  upgrader: string;
  rescuer: string;
  initialHolder: string;
  initialContractURI: string;
}

function isHexAddress(v: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

const ZERO = "0x0000000000000000000000000000000000000000";

async function main(): Promise<void> {
  const networkNameRaw = process.env["TARGET_CHAIN"] ?? "bsc";
  if (networkNameRaw !== "bsc") {
    throw new Error(`TARGET_CHAIN must be bsc, got ${networkNameRaw}`);
  }
  const chainKey = networkNameRaw as SupportedChainKey;

  // Shared env resolver — lenient (strict=false) so this offline calldata builder
  // runs without a BSC_RESCUER_ADDRESS. When rescuer is unset, env.rescuer="" and
  // the artefact is marked PLACEHOLDER so operators know it is not signable.
  const env = resolveBscEnv(process.env, {strict: false});
  const {defaultAdmin: safeAddr, rescuer: rescuerAddr, initialHolder, adminDelay, timelockDelay, contractURI} = env;

  const upgraderEnv = process.env["BSC_UPGRADER_ADDRESS"];
  const deployerEnv = process.env["BSC_DEPLOYER_ADDRESS"];

  if (upgraderEnv !== undefined && upgraderEnv.length > 0 && !isHexAddress(upgraderEnv)) {
    throw new Error(`BSC_UPGRADER_ADDRESS=${upgraderEnv} is not a valid hex address`);
  }

  const upgraderAddr = upgraderEnv && upgraderEnv.length > 0 ? upgraderEnv : ZERO;
  const zeroFields: string[] = [];
  if (upgraderAddr.toLowerCase() === ZERO) zeroFields.push("upgrader");
  if (rescuerAddr === "") zeroFields.push("rescuer");

  // Strict semantic validation. The PLACEHOLDER sentinel only catches
  // "address is zero / not set" cases. Operators can still feed non-zero
  // but semantically broken combos that produce FINAL (signable) calldata
  // which the contract will revert at execute time. Mirror initialize()
  // pre-checks here so signable artefacts are truly signable.
  const semanticIssues: string[] = [];
  // (1) Duplicate-role detection — initialize reverts DuplicateRoleAssignment
  //     when defaultAdmin == upgrader == rescuer, etc. (any two equal).
  if (rescuerAddr !== "" && rescuerAddr.toLowerCase() === safeAddr.toLowerCase()) {
    semanticIssues.push("rescuer == defaultAdmin (DuplicateRoleAssignment guard will revert initialize)");
  }
  if (upgraderAddr.toLowerCase() !== ZERO && upgraderAddr.toLowerCase() === safeAddr.toLowerCase()) {
    semanticIssues.push("upgrader == defaultAdmin (DuplicateRoleAssignment guard will revert initialize)");
  }
  if (rescuerAddr !== "" && upgraderAddr.toLowerCase() !== ZERO &&
      rescuerAddr.toLowerCase() === upgraderAddr.toLowerCase()) {
    semanticIssues.push("rescuer == upgrader (DuplicateRoleAssignment guard will revert initialize)");
  }
  // (2) Empty contract URI — initialize requires non-empty (NoEmptyContractURI).
  if (!contractURI || contractURI.trim() === "") {
    semanticIssues.push("contractURI is empty (NoEmptyContractURI guard will revert)");
  }
  // (3) initialHolder == predicted-proxy — locks 1B PARK at the proxy itself
  //     (rescueERC20(self) reverts CannotRescueSelf — supply unrecoverable).
  //     We can only check this when BSC_DEPLOYER_ADDRESS is set so we know
  //     the predicted address.
  let earlyPredicted: string | null = null;
  if (deployerEnv !== undefined && isHexAddress(deployerEnv)) {
    earlyPredicted = computeProxyAddress({
      factory: CREATE3_FACTORY_REGISTRY[chainKey].address,
      deployer: deployerEnv as `0x${string}`,
      salt: PARK_TOKEN_SALT
    });
    if (initialHolder.toLowerCase() === earlyPredicted.toLowerCase()) {
      semanticIssues.push(
        `initialHolder == predicted proxy ${earlyPredicted} — 1B PARK supply would be locked at the proxy itself ` +
          `(rescueERC20(this) reverts CannotRescueSelf). Set BSC_INITIAL_HOLDER to a different address.`
      );
    }
  }
  // (4) Admin delay outside contract bounds — initialize reverts at
  //     defaultAdminDelay < 24h or > 30d.
  if (adminDelay < 86_400 || adminDelay > 2_592_000) {
    semanticIssues.push(
      `defaultAdminTransferDelay=${adminDelay}s outside [86400, 2592000]; initialize will revert AdminDelayOutOfBounds`
    );
  }
  // (5) Upgrader EOA detection (UpgraderNotContract guard). Best-effort
  //     warning — we don't have RPC access here, so we can't read
  //     upgrader.code.length. Operator must rely on the post-deploy
  //     assertion + UPGRADE-HAZARDS H-3 monitoring.
  // (left as runtime-only check, no addition here.)

  const isPlaceholder = zeroFields.length > 0;
  const hasSemanticIssues = semanticIssues.length > 0;
  // The artefact is signable only when BOTH conditions hold:
  //   - no zero/missing required fields
  //   - no semantic invariant violation
  const isFinalSignable = !isPlaceholder && !hasSemanticIssues;

  // Use ZERO as the wire-encoded sentinel when rescuer is not yet set.
  // The contract's Zero* guards will reject this calldata — intentional,
  // since PLACEHOLDER artefacts must not be signed as-is.
  const rescuerWire = rescuerAddr !== "" ? rescuerAddr : ZERO;

  const cfg: ResolvedConfig = {
    defaultAdmin: safeAddr,
    defaultAdminTransferDelay: adminDelay,
    upgrader: upgraderAddr.toLowerCase() === ZERO
      ? "<<TIMELOCK_ADDRESS — set BSC_UPGRADER_ADDRESS env and re-run>>"
      : upgraderAddr,
    rescuer: rescuerAddr !== ""
      ? rescuerAddr
      : "<<RESCUER_ADDRESS — set BSC_RESCUER_ADDRESS env and re-run>>",
    initialHolder,
    initialContractURI: contractURI
  };

  const initData = encodeFunctionData({
    abi: getInitializeAbi(),
    functionName: "initialize",
    args: [
      {
        defaultAdmin: safeAddr as `0x${string}`,
        defaultAdminTransferDelay: adminDelay,
        upgrader: upgraderAddr as `0x${string}`,
        rescuer: rescuerWire as `0x${string}`,
        initialHolder: initialHolder as `0x${string}`,
        initialContractURI: contractURI
      }
    ]
  });

  // CREATE3 metadata
  const factory = CREATE3_FACTORY_REGISTRY[chainKey];
  const predictedAddress =
    deployerEnv && isHexAddress(deployerEnv)
      ? computeProxyAddress({
          factory: factory.address,
          deployer: deployerEnv as `0x${string}`,
          salt: PARK_TOKEN_SALT
        })
      : "<<UNKNOWN — set BSC_DEPLOYER_ADDRESS env to compute>>";

  // Function signature for initialize
  const fragmentSignature =
    "initialize((address defaultAdmin, uint48 defaultAdminTransferDelay, address upgrader, address rescuer, address initialHolder, string initialContractURI))";

  const calldataArtefact = {
    chain: chainKey,
    chainId: factory.chainId,
    artefactStatus: isFinalSignable
      ? "FINAL (signable)"
      : isPlaceholder
        ? "PLACEHOLDER (review-only — missing required fields)"
        : "INVALID (review-only — semantic invariant violation)",
    note: isFinalSignable
      ? "Final calldata. Verify each field of initConfigHumanReadable matches the agreed governance parameters before signing."
      : isPlaceholder
        ? `Placeholder fields: [${zeroFields.join(", ")}]. The encoded calldata is guaranteed to revert on-chain (Zero* and DuplicateRoleAssignment guards in initialize). Set the corresponding env var(s) and re-run to produce signable calldata.`
        : `Semantic invariant violation: [${semanticIssues.join("; ")}]. Calldata will revert on-chain at initialize() time.`,
    zeroFields,
    semanticIssues,
    timelockDelay,
    initConfigHumanReadable: cfg,
    initializeCalldata: initData,
    initializeFunctionSelector: getSelector(initData),
    fragmentSignature,
    create3: {
      salt: PARK_TOKEN_SALT,
      factoryAddress: factory.address,
      factoryExtcodehash: factory.expectedExtcodehash,
      factoryVersion: factory.factoryVersion,
      predictedAddress
    }
  };

  const calldataPath = join(process.cwd(), `ops/210-base-init-calldata-${chainKey}.json`);
  writeFileSync(calldataPath, `${JSON.stringify(calldataArtefact, null, 2)}\n`);
  console.log(`Calldata artefact: ${calldataPath}`);

  // Minimal ABI subset — load from artifact + filter to known function/event names
  const fullAbi = loadAbi("artifacts/contracts/ParkToken.sol/ParkToken.json");

  const functionNames = new Set([
    "initialize",
    "cap",
    "totalSupply",
    "balanceOf",
    "implVersion",
    "contractURI",
    "setContractURI",
    "mint",
    "burn",
    "burnFrom",
    "transfer",
    "transferFrom",
    "approve",
    "permit",
    "rescueERC20",
    "rescueETH",
    "hasRole",
    "getRoleAdmin",
    "renounceRole",
    "revokeRole",
    "grantRole",
    "DEFAULT_ADMIN_ROLE",
    "UPGRADER_ROLE",
    "TIMELOCK_ADMIN_ROLE",
    "RESCUER_ROLE",
    "INITIAL_SUPPLY"
  ]);

  const eventNames = new Set(["RescuedERC20", "RescuedETH", "ContractURIUpdated"]);

  const abiSubset = fullAbi.filter(
    (f) =>
      (f.type === "function" && f.name !== undefined && functionNames.has(f.name)) ||
      (f.type === "event" && f.name !== undefined && eventNames.has(f.name))
  );

  const abiArtefact = {
    contractName: "ParkToken",
    abiSubset
  };

  const abiPath = join(process.cwd(), "ops/210-base-abi.json");
  writeFileSync(abiPath, `${JSON.stringify(abiArtefact, null, 2)}\n`);
  console.log(`ABI artefact:      ${abiPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
