#!/usr/bin/env node
// Generates ops/park-token-governance-abi.json from compiled Hardhat
// artifacts. This ABI subset is for operator MONITORING (Tenderly Alerts /
// Forta / OZ Defender / The Graph) covering role mutations, upgrade
// events, Timelock scheduling/execution, and admin transfers. Distinct
// from ops/210-base-abi.json (deploy-time) and ops/park-token-integrator-abi.json
// (downstream wallets).
//
// Usage:
//   npx hardhat compile     # populate artifacts/
//   node scripts/ops/build-governance-abi.mjs
//
// Makes the ABI snapshot reproducible by any reviewer.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Require the v1.2 artifact (the live implementation). No silent fallback to an
// older ParkToken artifact — that would drop the pause / role surface the
// monitoring snapshot exists to cover.
const tokenArtifact =
  process.env.PARK_TOKEN_ARTIFACT ??
  "artifacts/contracts/ParkTokenV1_2.sol/ParkTokenV1_2.json";

if (!existsSync(tokenArtifact)) {
  throw new Error(
    `Artifact not found: ${tokenArtifact}. Run \`npx hardhat compile\` first, ` +
      `or set PARK_TOKEN_ARTIFACT to the intended version's artifact path.`
  );
}

const tokenAbi = JSON.parse(readFileSync(tokenArtifact, "utf-8")).abi;

// Defend against a stale artifact: the monitoring ABI must carry the v1.2
// pause / role surface or alerts would silently miss it.
for (const [kind, name] of [
  ["event", "Paused"], ["event", "Unpaused"],
  ["function", "PAUSER_ROLE"], ["function", "paused"],
]) {
  if (!tokenAbi.some((x) => x.type === kind && x.name === name)) {
    throw new Error(
      `${tokenArtifact} is missing ${kind} ${name} — generate from ParkTokenV1_2 or later.`
    );
  }
}
const tlAbi = JSON.parse(
  readFileSync(
    "artifacts/contracts/imports/TimelockControllerImport.sol/ParkTimelockController.json",
    "utf-8"
  )
).abi;
const proxyAbi = JSON.parse(
  readFileSync(
    "artifacts/contracts/imports/ERC1967ProxyImport.sol/ParkERC1967Proxy.json",
    "utf-8"
  )
).abi;

const tokenGovEvents = [
  "RoleGranted", "RoleRevoked", "RoleAdminChanged",
  "DefaultAdminTransferScheduled", "DefaultAdminTransferCanceled",
  "DefaultAdminDelayChangeScheduled", "DefaultAdminDelayChangeCanceled",
  "Upgraded", "Paused", "Unpaused", "Initialized",
  "RescuedERC20", "RescuedETH", "ContractURIUpdated", "Transfer"
];
const tokenGovFns = [
  "hasRole", "getRoleAdmin",
  "defaultAdmin", "pendingDefaultAdmin", "defaultAdminDelay",
  "owner", "implVersion", "cap", "totalSupply", "DOMAIN_SEPARATOR",
  "PAUSER_ROLE", "paused"
];
const tlEvents = [
  "CallScheduled", "CallExecuted", "CallSalt", "Cancelled",
  "MinDelayChange", "RoleGranted", "RoleRevoked", "RoleAdminChanged"
];
const tlFns = [
  "getMinDelay", "hasRole",
  "isOperation", "isOperationPending", "isOperationReady", "isOperationDone",
  "getTimestamp"
];
const proxyEvents = ["Upgraded", "AdminChanged", "BeaconUpgraded"];

const select = (abi, names, kinds) =>
  abi.filter((x) => kinds.includes(x.type) && names.includes(x.name));

const out = {
  generatedAt: new Date().toISOString(),
  generatedBy: "scripts/ops/build-governance-abi.mjs",
  sourceArtifact: tokenArtifact,
  description:
    "Governance + Timelock + proxy event/function ABI subset for monitoring (Tenderly Alerts / Forta / The Graph). Distinct from ops/210-base-abi.json (deploy-time slim ABI).",
  contracts: {
    ParkToken: {
      address: "<proxy address depends on chain>",
      abi: select(tokenAbi, [...tokenGovEvents, ...tokenGovFns], ["event", "function", "error"])
    },
    ParkTimelockController: {
      address: "<timelock address per chain>",
      abi: select(tlAbi, [...tlEvents, ...tlFns], ["event", "function"])
    },
    ParkERC1967Proxy: {
      address: "<same as ParkToken proxy>",
      abi: select(proxyAbi, proxyEvents, ["event"])
    }
  }
};

writeFileSync("ops/park-token-governance-abi.json", JSON.stringify(out, null, 2));
console.log(
  "written ops/park-token-governance-abi.json:",
  "ParkToken events:",
  out.contracts.ParkToken.abi.filter((x) => x.type === "event").length,
  "fns:",
  out.contracts.ParkToken.abi.filter((x) => x.type === "function").length,
  "/ Timelock events:",
  out.contracts.ParkTimelockController.abi.filter((x) => x.type === "event").length
);
