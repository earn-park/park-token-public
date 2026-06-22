#!/usr/bin/env node
// Generates ops/park-token-integrator-abi.json from the compiled Hardhat
// artifact. This ABI subset is what wallets / DEXes / indexers / oracles
// need to integrate PARK Token (full ERC-20 + ERC-2612 + read-only
// governance views). Distinct from:
//   - ops/210-base-abi.json — deploy-time ABI (build-bsc-calldata.ts)
//   - ops/park-token-governance-abi.json — operator monitoring ABI
//
// Usage:
//   npx hardhat compile     # populate artifacts/
//   node scripts/ops/build-integrator-abi.mjs
//
// Keeps generator provenance reproducible (committing the snapshot alone
// leaves reviewers guessing how it was produced).

import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Require the v1.2 artifact (the live implementation). No silent fallback to an
// older ParkToken artifact — that would regenerate this snapshot without the
// pause surface (paused / Paused / Unpaused) and publish a stale ABI.
const sourceArtifact =
  process.env.PARK_TOKEN_ARTIFACT ??
  "artifacts/contracts/ParkTokenV1_2.sol/ParkTokenV1_2.json";

if (!existsSync(sourceArtifact)) {
  throw new Error(
    `Artifact not found: ${sourceArtifact}. Run \`npx hardhat compile\` first, ` +
      `or set PARK_TOKEN_ARTIFACT to the intended version's artifact path.`
  );
}

const tokenAbi = JSON.parse(readFileSync(sourceArtifact, "utf-8")).abi;

const erc20Functions = [
  "name", "symbol", "decimals", "totalSupply",
  "balanceOf", "transfer", "approve", "transferFrom", "allowance"
];
const permitFunctions = ["DOMAIN_SEPARATOR", "nonces", "permit", "eip712Domain"];
const burnableFunctions = ["burn", "burnFrom"];
const pausableFunctions = ["paused"];
const introspection = ["cap", "implVersion", "contractURI", "supportsInterface"];
const erc20Events = ["Transfer", "Approval"];
const permitEvents = ["EIP712DomainChanged"];
const otherEvents = ["ContractURIUpdated", "Upgraded", "Paused", "Unpaused"];

const wantedFns = [...erc20Functions, ...permitFunctions, ...burnableFunctions, ...pausableFunctions, ...introspection];
const wantedEvents = [...erc20Events, ...permitEvents, ...otherEvents];

const sel = tokenAbi.filter(
  (x) =>
    (x.type === "function" && wantedFns.includes(x.name)) ||
    (x.type === "event" && wantedEvents.includes(x.name)) ||
    x.type === "error"
);

// Defend against a stale PARK_TOKEN_ARTIFACT override silently dropping the
// pause surface from the published snapshot.
const missingPause = [
  ...pausableFunctions.filter((n) => !sel.some((x) => x.type === "function" && x.name === n)),
  ...["Paused", "Unpaused"].filter((n) => !sel.some((x) => x.type === "event" && x.name === n)),
];
if (missingPause.length > 0) {
  throw new Error(
    `${sourceArtifact} is missing the v1.2 pause surface: ${missingPause.join(", ")}. ` +
      `Generate from ParkTokenV1_2 or later.`
  );
}

const out = {
  generatedAt: new Date().toISOString(),
  generatedBy: "scripts/ops/build-integrator-abi.mjs",
  sourceArtifact,
  description:
    "Integrator ABI for PARK Token. Includes the full ERC-20 + ERC-2612 (permit) surface plus read-only governance/cap views — what wallets, DEXes, indexers, and oracles need to integrate. Distinct from ops/210-base-abi.json (deploy-time ABI subset) and ops/park-token-governance-abi.json (operator monitoring ABI).",
  contract: "ParkToken (ERC-20 + ERC-2612 + capped + UUPS)",
  notes: {
    decimals:
      "6 - non-standard! Most ERC-20s use 18. Integrators reading raw amounts MUST scale by 10^6, not 10^18.",
    permit:
      "Standard EIP-2612. nonces() increments per holder per successful permit. Same-chain replay impossible (per-owner nonce); cross-chain replay impossible (DOMAIN_SEPARATOR includes block.chainid). Permit-grief (a third party calling permit on a holder's signed payload to grief allowance) is the standard ERC-2612 footgun; integrators relying on permit should treat it as 'replaces approve' not 'in addition to approve'.",
    supply:
      "v1.1 removes mint(). Holder burns reduce totalSupply and no role can re-issue burned supply after v1.1.",
    pause:
      "v1.2 adds global pause/unpause under PAUSER_ROLE only. There is no freeze/blocklist/wipe/admin force-burn surface.",
    upgradeability:
      "UUPS proxy. Implementation address and ABI may change via Timelock-mediated upgrade. Re-fetch ABI from explorer or this file after every Upgraded(address) event.",
    deadlineStrategy:
      "permit deadlines: use short windows (5-15 min). The signature can be replayed within the deadline by anyone (not against the same allowance, but as a separate confirmation tx); pick the shortest window that survives RPC + mempool latency."
  },
  abi: sel
};

writeFileSync("ops/park-token-integrator-abi.json", JSON.stringify(out, null, 2));
console.log(
  "written ops/park-token-integrator-abi.json:",
  out.abi.filter((x) => x.type === "function").length, "functions,",
  out.abi.filter((x) => x.type === "event").length, "events,",
  out.abi.filter((x) => x.type === "error").length, "errors"
);
