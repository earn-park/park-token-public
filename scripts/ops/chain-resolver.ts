// Generic chain resolver for ops scripts. Routes on TARGET_CHAIN env var.
//
// Supported chains: bsc
//
// Used by:
//   - scripts/ops/safe-exec.ts
//   - scripts/ops/schedule-upgrade.ts
//   - scripts/ops/deploy-base-upgrade-impl.ts

import { bsc, type Chain } from "viem/chains";

export type SupportedChainKey = "bsc";

interface ChainEntry {
  chain: Chain;
  rpcEnvName: string;
  privateKeyEnvName: string;
  safeTxServiceUrl: string;
}

const REGISTRY: Record<SupportedChainKey, ChainEntry> = {
  bsc: {
    chain: bsc,
    rpcEnvName: "BSC_RPC_URL",
    privateKeyEnvName: "BSC_PRIVATE_KEY",
    safeTxServiceUrl: "https://safe-transaction-bsc.safe.global",
  },
};

export type ResolvedChain = ChainEntry;

export function resolveChain(env: NodeJS.ProcessEnv): ResolvedChain {
  const key = env["TARGET_CHAIN"];
  if (!key) throw new Error("TARGET_CHAIN not set");
  if (!(key in REGISTRY)) {
    throw new Error(`Unsupported chain: ${key} (allowed: bsc)`);
  }
  return REGISTRY[key as SupportedChainKey];
}
