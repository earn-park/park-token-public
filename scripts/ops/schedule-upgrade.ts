// Single-signer SafeTx helper for Timelock.schedule (proxy upgrades).
//
// Builds calldata for `upgradeToAndCall(newImpl, reinitCalldata)`, then posts
// the Timelock.schedule via Safe execTransaction using EIP-712 signing.
//
// Usage:
//   TARGET_CHAIN=bsc \
//   PROXY_ADDRESS=0x... \
//   TIMELOCK_ADDRESS=0x... \
//   NEW_IMPL_ADDRESS=0x... \
//   REINIT_SIGNATURE='reinitialize()' \
//   UPGRADE_SALT_LABEL='v1.0.0 -> v1.1.0' \
//   SAFE_ADDRESS=0x... \
//     npx tsx scripts/ops/schedule-upgrade.ts
//
// TARGET_CHAIN drives which RPC/private-key env vars are used:
//   bsc → BSC_RPC_URL + BSC_PRIVATE_KEY
//
// Optional:
//   TIMELOCK_PREDECESSOR=0x... (default 0x0 — no predecessor)
//   DELAY_SECONDS=900 (default read from Timelock.getMinDelay())

import "dotenv/config";

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  stringToBytes,
  type Address,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveChain } from "./chain-resolver.js";

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" }
  ]
} as const;

const SAFE_ABI = [
  { type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  {
    type: "function",
    name: "execTransaction",
    stateMutability: "payable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "signatures", type: "bytes" }
    ],
    outputs: [{ type: "bool" }]
  }
] as const;

const TIMELOCK_ABI = [
  {
    type: "function",
    name: "schedule",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "predecessor", type: "bytes32" },
      { name: "salt", type: "bytes32" },
      { name: "delay", type: "uint256" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "hashOperation",
    stateMutability: "pure",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "predecessor", type: "bytes32" },
      { name: "salt", type: "bytes32" }
    ],
    outputs: [{ type: "bytes32" }]
  },
  {
    type: "function",
    name: "getMinDelay",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }]
  }
] as const;

const UPGRADE_ABI = [
  {
    type: "function",
    name: "upgradeToAndCall",
    stateMutability: "payable",
    inputs: [
      { name: "newImplementation", type: "address" },
      { name: "data", type: "bytes" }
    ],
    outputs: []
  }
] as const;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing env ${name}`);
  }
  return v.trim();
}

async function main(): Promise<void> {
  const resolved = resolveChain(process.env);
  const rpcUrl = requireEnv(resolved.rpcEnvName);
  const safeAddress = getAddress(requireEnv("SAFE_ADDRESS")) as Address;
  const proxyAddr = getAddress(requireEnv("PROXY_ADDRESS"));
  const timelockAddr = getAddress(requireEnv("TIMELOCK_ADDRESS"));
  const newImplAddr = getAddress(requireEnv("NEW_IMPL_ADDRESS"));
  const reinitSignature = requireEnv("REINIT_SIGNATURE"); // e.g. 'reinitialize()'
  const saltLabel = requireEnv("UPGRADE_SALT_LABEL");
  const predecessor = (process.env["TIMELOCK_PREDECESSOR"] ?? `0x${"0".repeat(64)}`) as Hex;

  const pk = requireEnv(resolved.privateKeyEnvName);
  const account = privateKeyToAccount(pk.startsWith("0x") ? (pk as Hex) : (`0x${pk}` as Hex));

  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: resolved.chain, transport });
  const walletClient = createWalletClient({ account, chain: resolved.chain, transport });

  const chainId = await publicClient.getChainId();
  if (chainId !== resolved.chain.id) {
    throw new Error(`Wrong chainId ${chainId}, expected ${resolved.chain.id}`);
  }

  // Build the reinit calldata. Keep it simple — only supports zero-arg reinits.
  // For parametrized reinitializers, extend this script or build calldata externally.
  const reinitSelector = keccak256(stringToBytes(reinitSignature)).slice(0, 10) as Hex;
  console.log(`Reinit signature: ${reinitSignature}`);
  console.log(`Reinit selector:  ${reinitSelector}`);

  const upgradeCalldata = encodeFunctionData({
    abi: UPGRADE_ABI,
    functionName: "upgradeToAndCall",
    args: [newImplAddr, reinitSelector]
  });

  const salt = keccak256(stringToBytes(saltLabel));
  console.log(`Salt label:       ${saltLabel}`);
  console.log(`Salt:             ${salt}`);

  const delay = process.env["DELAY_SECONDS"]
    ? BigInt(process.env["DELAY_SECONDS"])
    : await publicClient.readContract({
        address: timelockAddr,
        abi: TIMELOCK_ABI,
        functionName: "getMinDelay"
      });
  console.log(`Delay:            ${delay}s`);

  const opId = await publicClient.readContract({
    address: timelockAddr,
    abi: TIMELOCK_ABI,
    functionName: "hashOperation",
    args: [proxyAddr, 0n, upgradeCalldata, predecessor, salt]
  });
  console.log(`Operation ID:     ${opId}`);

  const scheduleCalldata = encodeFunctionData({
    abi: TIMELOCK_ABI,
    functionName: "schedule",
    args: [proxyAddr, 0n, upgradeCalldata, predecessor, salt, delay]
  });

  // Single-signer helper: each signer invokes this script independently to collect their
  // EIP-712 signature. For threshold > 1, the final caller concatenates all collected
  // signatures and passes them to execTransaction. For 1/1 Safes this script submits directly.
  const [threshold, owners, safeNonce] = await Promise.all([
    publicClient.readContract({ address: safeAddress, abi: SAFE_ABI, functionName: "getThreshold" }),
    publicClient.readContract({ address: safeAddress, abi: SAFE_ABI, functionName: "getOwners" }),
    publicClient.readContract({ address: safeAddress, abi: SAFE_ABI, functionName: "nonce" })
  ]);
  if (threshold !== 1n) throw new Error(`Safe threshold ${threshold} — this helper submits a single-signer SafeTx. For threshold > 1, collect each signer's EIP-712 signature separately and concatenate before calling execTransaction.`);
  if (!owners.map((o) => o.toLowerCase()).includes(account.address.toLowerCase())) {
    throw new Error(`Signer not owner. Owners: ${owners.join(", ")}`);
  }

  const safeTx = {
    to: timelockAddr,
    value: 0n,
    data: scheduleCalldata,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: "0x0000000000000000000000000000000000000000" as Address,
    refundReceiver: "0x0000000000000000000000000000000000000000" as Address,
    nonce: safeNonce
  } as const;

  const signature = await walletClient.signTypedData({
    account,
    domain: { chainId: BigInt(chainId), verifyingContract: safeAddress },
    types: SAFE_TX_TYPES,
    primaryType: "SafeTx",
    message: safeTx
  });

  console.log(`\n[Safe schedule] submitting execTransaction...`);
  const txHash = await walletClient.writeContract({
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: "execTransaction",
    args: [
      safeTx.to,
      safeTx.value,
      safeTx.data,
      safeTx.operation,
      safeTx.safeTxGas,
      safeTx.baseGas,
      safeTx.gasPrice,
      safeTx.gasToken,
      safeTx.refundReceiver,
      signature
    ]
  });
  console.log(`  tx: ${txHash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`Safe execTransaction reverted: ${txHash}`);

  const readyAt = Math.floor(Date.now() / 1000) + Number(delay);
  console.log(`\nScheduled. Block ${receipt.blockNumber}, gas ${receipt.gasUsed}.`);
  console.log(`Operation ready to execute at UNIX ${readyAt} (+${delay}s from now).`);
  console.log(`\nTo execute (from ANY EOA, executor role is wildcard 0x0):`);
  console.log(
    `  cast send ${timelockAddr} 'execute(address,uint256,bytes,bytes32,bytes32)' \\\n` +
      `    ${proxyAddr} 0 ${upgradeCalldata} ${predecessor} ${salt} \\\n` +
      `    --private-key $${resolved.privateKeyEnvName} --rpc-url $${resolved.rpcEnvName}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
