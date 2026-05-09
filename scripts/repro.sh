#!/usr/bin/env bash
# Bytecode reproducibility check for audit verification.
#
# Computes deployedBytecode keccak256 hashes for both Foundry and Hardhat
# artifact families (mega-review H-3: deploy-bsc.ts loads Hardhat artifacts;
# Foundry-only baseline left a verification gap), then asserts each hash
# against docs/BYTECODE-BASELINE.md and exits nonzero on any mismatch
# (mega-review H-2: previous version printed-without-asserting).

set -euo pipefail
cd "$(dirname "$0")/.."

EXPECTED_FOUNDRY_SHA="b0a9dd9c"

echo "=== Foundry version ==="
forge --version
forge --version | grep -q "$EXPECTED_FOUNDRY_SHA" || {
  echo "::error::Foundry SHA drift — expected $EXPECTED_FOUNDRY_SHA, got $(forge --version)"
  exit 1
}
echo ""

echo "=== Cleaning artifacts ==="
trash out cache cache_hardhat artifacts 2>/dev/null || rm -rf out cache cache_hardhat artifacts
echo ""

echo "=== Reinstalling deps from lockfile ==="
npm ci --ignore-scripts
echo ""

echo "=== Compiling Hardhat artifacts (deploy script consumes these) ==="
npx hardhat compile 2>&1 | tail -3
echo ""

echo "=== Compiling Foundry artifacts (baseline anchor) ==="
forge build --offline
echo ""

echo "=== Computing bytecode hashes (Foundry + Hardhat) ==="
node --import tsx <<'NODE'
import { readFileSync } from "node:fs";
import { keccak256 } from "viem";

const targets = [
  {
    name: "ParkToken",
    foundry: "out/ParkToken.sol/ParkToken.json",
    hardhat: "artifacts/contracts/ParkToken.sol/ParkToken.json",
  },
  {
    name: "ParkERC1967Proxy",
    foundry: "out/ERC1967ProxyImport.sol/ParkERC1967Proxy.json",
    hardhat: "artifacts/contracts/imports/ERC1967ProxyImport.sol/ParkERC1967Proxy.json",
  },
  {
    name: "ParkTimelockController",
    foundry: "out/TimelockControllerImport.sol/ParkTimelockController.json",
    hardhat: "artifacts/contracts/imports/TimelockControllerImport.sol/ParkTimelockController.json",
  },
];

const computed = {};
for (const { name, foundry, hardhat } of targets) {
  const fA = JSON.parse(readFileSync(foundry, "utf-8"));
  const fBc = fA.deployedBytecode?.object ?? fA.deployedBytecode;
  const fHash = keccak256(fBc);

  const hA = JSON.parse(readFileSync(hardhat, "utf-8"));
  const hBc = hA.deployedBytecode;
  const hHash = keccak256(hBc);

  computed[name] = { foundry: fHash, hardhat: hHash };
  console.log(`${name}:`);
  console.log(`  Foundry deployedBytecode keccak256 = ${fHash}`);
  console.log(`  Hardhat deployedBytecode keccak256 = ${hHash}`);
}

// Persist for the bash assertion step.
import { writeFileSync } from "node:fs";
writeFileSync("/tmp/repro-hashes.json", JSON.stringify(computed, null, 2));
NODE

echo ""
echo "=== Asserting hashes against docs/BYTECODE-BASELINE.md ==="

BASELINE=docs/BYTECODE-BASELINE.md
FAIL=0
for entry in \
  "ParkToken:foundry" \
  "ParkToken:hardhat" \
  "ParkERC1967Proxy:foundry" \
  "ParkERC1967Proxy:hardhat" \
  "ParkTimelockController:foundry" \
  "ParkTimelockController:hardhat"; do
  name=${entry%:*}
  family=${entry#*:}
  # Capitalise without bash 4+ or GNU sed (macOS portability).
  case "$family" in
    foundry) family_cap=Foundry ;;
    hardhat) family_cap=Hardhat ;;
    *) echo "::error::unknown family $family"; exit 1 ;;
  esac
  computed=$(node -e "console.log(require('/tmp/repro-hashes.json')['$name']['$family'])")
  # Match the row by both name token and family-marker; baseline lines are:
  #   | `<name>` (Foundry) | <toolchain version> | `0x...` |
  #   | `<name>` (Hardhat) | <toolchain version> | `0x...` |
  expected=$(grep -E "\`${name}\` \(${family_cap}\)" "$BASELINE" | grep -oE '0x[0-9a-f]{64}' | head -1)
  if [ -z "$expected" ]; then
    echo "❌ $name ($family): no baseline row found in $BASELINE"
    FAIL=1
  elif [ "$computed" = "$expected" ]; then
    echo "✓ $name ($family) = $computed"
  else
    echo "❌ $name ($family) DRIFT"
    echo "    expected $expected"
    echo "    computed $computed"
    FAIL=1
  fi
done

if [ $FAIL -ne 0 ]; then
  echo ""
  echo "::error::Bytecode baseline drift. Update docs/BYTECODE-BASELINE.md if intentional, or investigate toolchain/source changes."
  exit 1
fi

echo ""
echo "=== DONE — all hashes match baseline ==="
