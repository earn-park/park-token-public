// ESLint flat config — enforces the viem-only TypeScript policy.
//
// Default: ethers.js / hardhat-ethers / hardhat-upgrades imports are errors
// everywhere except the one file that requires hardhat-ethers for impl-only
// deployment (scripts/ops/deploy-base-upgrade-impl.ts).
// scripts/deploy/base/** is viem-only.

import tsParser from "@typescript-eslint/parser";

/** @type {import('eslint').Linter.FlatConfig[]} */
export default [
  {
    ignores: [
      "node_modules/**",
      "artifacts/**",
      "cache_hardhat/**",
      "out/**",
      "cache/**",
      "broadcast/**",
      "coverage/**",
      "lib/**"
    ]
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module"
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "ethers",
              message:
                "ethers.js not allowed — use viem. Exception: scripts/ops/deploy-base-upgrade-impl.ts (hardhat ethers bridge)."
            },
            {
              name: "@nomicfoundation/hardhat-ethers",
              message:
                "hardhat-ethers not allowed — use viem."
            },
            {
              name: "@openzeppelin/hardhat-upgrades",
              message:
                "hardhat-upgrades not used — use viem + Timelock flow."
            }
          ]
        }
      ]
    }
  },
  {
    // hardhat.config.ts registers hardhat-ethers as a plugin (required for
    // deploy-base-upgrade-impl.ts type augmentation — not used at runtime).
    // deploy-base-upgrade-impl.ts uses ethers via hre for one-line factory deploy.
    // All other scripts/ops/** and scripts/deploy/base/** are pure viem.
    files: [
      "hardhat.config.ts",
      "scripts/ops/deploy-base-upgrade-impl.ts"
    ],
    rules: {
      "no-restricted-imports": "off"
    }
  }
];
