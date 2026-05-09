#!/usr/bin/env bash
# Bytecode reproducibility check for audit verification
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== Foundry version ==="
forge --version
echo ""

echo "=== Cleaning artifacts ==="
trash out cache cache_hardhat artifacts 2>/dev/null || rm -rf out cache cache_hardhat artifacts
echo ""

echo "=== Reinstalling deps from lockfile ==="
npm ci --ignore-scripts
echo ""

echo "=== Compiling Hardhat artifacts (for TS tests) ==="
npx hardhat compile 2>&1 | tail -3
echo ""

echo "=== Compiling Foundry artifacts ==="
forge build --offline
echo ""

echo "=== Bytecode hashes (Foundry artifacts: out/<source>/<contract>.json) ==="
node --import tsx <<'NODE'
import { readFileSync } from "node:fs";
import { keccak256 } from "viem";
const targets = [
  ["ParkToken",             "out/ParkToken.sol/ParkToken.json"],
  ["ParkERC1967Proxy",      "out/ERC1967ProxyImport.sol/ParkERC1967Proxy.json"],
  ["ParkTimelockController","out/TimelockControllerImport.sol/ParkTimelockController.json"],
];
for (const [name, path] of targets) {
  const a = JSON.parse(readFileSync(path, "utf-8"));
  const bc = a.deployedBytecode?.object ?? a.deployedBytecode;
  console.log(name + ": deployedBytecode keccak256 = " + keccak256(bc));
}
NODE
echo ""
echo "=== DONE ==="
