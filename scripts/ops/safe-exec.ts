// Single-signer SafeTx helper.
//
// Used by individual signers when collecting EIP-712 signatures for a
// multi-sig threshold > 1, or by a 1/1 deploy Safe directly.
//
// Accepts any target + function signature + ABI-typed args, encodes calldata,
// then signs and submits the SafeTx via EIP-712.
//
// Usage:
//   TARGET_CHAIN=bsc \
//   SAFE_ADDRESS=0x... \
//   SAFE_TARGET=0x... \
//   SAFE_FUNCTION='mint(address,uint256)' \
//   SAFE_ARGS='["0xabc...","1000000"]' \
//     npx tsx scripts/ops/safe-exec.ts
//
//   TARGET_CHAIN=bsc \
//   SAFE_ADDRESS=0x... \
//   SAFE_TARGET=0x... \
//   SAFE_FUNCTION='grantRole(bytes32,address)' \
//   SAFE_ARGS='["0x0000000000000000000000000000000000000000000000000000000000000000","0xabc..."]' \
//     npx tsx scripts/ops/safe-exec.ts
//
// TARGET_CHAIN drives which RPC/private-key env vars are used:
//   bsc → BSC_RPC_URL + BSC_PRIVATE_KEY
//
// Examples of common ops (mint, setContractURI, grantRole, revokeRole)
// covered by this helper. For Timelock schedule/execute use the
// dedicated schedule-upgrade.ts which encodes upgrade-specific flows.

import "dotenv/config";

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbiItem,
  type AbiFunction,
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

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") throw new Error(`Missing env ${name}`);
  return v.trim();
}

function parseArgs(json: string): readonly unknown[] {
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error("SAFE_ARGS must be a JSON array (use [] for zero-arg functions)");
  }
  return parsed;
}

async function main(): Promise<void> {
  const resolved = resolveChain(process.env);
  const rpcUrl = requireEnv(resolved.rpcEnvName);
  const safeAddress = getAddress(requireEnv("SAFE_ADDRESS")) as Address;
  const target = getAddress(requireEnv("SAFE_TARGET")) as Address;
  const functionSignature = requireEnv("SAFE_FUNCTION");
  const argsJson = process.env["SAFE_ARGS"] ?? "[]";
  const valueWei = BigInt(process.env["SAFE_VALUE_WEI"] ?? "0");

  // Parse ABI from signature like "mint(address,uint256)" / "grantRole(bytes32,address)".
  // viem's parseAbiItem understands 'function X(...) [returns ...]' — we
  // accept both 'mint(address,uint256)' and 'function mint(address,uint256)'; normalize.
  const sigNormalized = functionSignature.startsWith("function ")
    ? functionSignature
    : `function ${functionSignature}`;
  const abiItem = parseAbiItem(sigNormalized);
  if (abiItem.type !== "function") {
    throw new Error(`SAFE_FUNCTION must be a function signature, got ${abiItem.type}`);
  }

  const args = parseArgs(argsJson);
  const abi: AbiFunction[] = [abiItem];
  const calldata = encodeFunctionData({
    abi,
    functionName: abiItem.name,
    args: args as readonly unknown[]
  });

  const pk = requireEnv(resolved.privateKeyEnvName);
  const account = privateKeyToAccount(pk.startsWith("0x") ? (pk as Hex) : (`0x${pk}` as Hex));

  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: resolved.chain, transport });
  const walletClient = createWalletClient({ account, chain: resolved.chain, transport });

  const chainId = await publicClient.getChainId();
  if (chainId !== resolved.chain.id) {
    throw new Error(`Wrong chainId ${chainId}, expected ${resolved.chain.id}`);
  }

  const [threshold, owners, safeNonce] = await Promise.all([
    publicClient.readContract({ address: safeAddress, abi: SAFE_ABI, functionName: "getThreshold" }),
    publicClient.readContract({ address: safeAddress, abi: SAFE_ABI, functionName: "getOwners" }),
    publicClient.readContract({ address: safeAddress, abi: SAFE_ABI, functionName: "nonce" })
  ]);
  // Self-signer / multisig dual-mode (mega-review H-5).
  //
  // Threshold == 1 (bootstrap): script signs and submits execTransaction
  //   directly in the same process. Used for test infrastructure deploys.
  //
  // Threshold >= 2 (production): script switches to "calldata-emit mode" —
  //   builds the SafeTx + computes the SafeTxHash and prints them to stdout
  //   for the operator to upload to the Safe Wallet UI / Safe Transaction
  //   Service, where the >=N owners co-sign and execute via the official
  //   multisig flow. The script does NOT submit; it exits successfully
  //   after emitting the calldata. Set VESTING_ALLOW_BOOTSTRAP_THRESHOLD=
  //   true (no analogue here — Safe-exec policy is symmetric).
  if (!owners.map((o) => o.toLowerCase()).includes(account.address.toLowerCase())) {
    throw new Error(`Signer ${account.address} not Safe owner. Owners: ${owners.join(", ")}`);
  }
  const isBootstrap = threshold === 1n;

  console.log(`Safe:        ${safeAddress}`);
  console.log(`Target:      ${target}`);
  console.log(`Function:    ${functionSignature}`);
  console.log(`Args:        ${argsJson}`);
  console.log(`Calldata:    ${calldata}`);
  console.log(`Value (wei): ${valueWei}`);
  console.log(`Nonce:       ${safeNonce}\n`);

  const safeTx = {
    to: target,
    value: valueWei,
    data: calldata,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: "0x0000000000000000000000000000000000000000" as Address,
    refundReceiver: "0x0000000000000000000000000000000000000000" as Address,
    nonce: safeNonce
  } as const;

  if (!isBootstrap) {
    // Multisig calldata-emit mode (mega-review H-5). Prints the SafeTx
    // payload + the EIP-712 SafeTxHash so operators can upload via the
    // Safe Wallet UI / Safe Transaction Service. Does NOT submit.
    const { hashTypedData } = await import("viem");
    const safeTxHash = hashTypedData({
      domain: { chainId: BigInt(chainId), verifyingContract: safeAddress },
      types: SAFE_TX_TYPES,
      primaryType: "SafeTx",
      message: safeTx
    });
    console.log(`\n=== MULTISIG MODE (threshold=${threshold}) ===`);
    console.log(`This Safe requires ${threshold} signatures. This script will`);
    console.log(`NOT submit; it emits the SafeTx for operator upload.`);
    console.log(`\nSafeTx payload:`);
    console.log(JSON.stringify({
      to: safeTx.to,
      value: safeTx.value.toString(),
      data: safeTx.data,
      operation: safeTx.operation,
      safeTxGas: safeTx.safeTxGas.toString(),
      baseGas: safeTx.baseGas.toString(),
      gasPrice: safeTx.gasPrice.toString(),
      gasToken: safeTx.gasToken,
      refundReceiver: safeTx.refundReceiver,
      nonce: safeTx.nonce.toString()
    }, null, 2));
    console.log(`\nSafeTxHash: ${safeTxHash}`);
    console.log(`\nNext steps:`);
    console.log(`  1. Open https://app.safe.global/transactions/queue?safe=<chain>:${safeAddress}`);
    console.log(`  2. New tx → Contract interaction → fill the fields above`);
    console.log(`  3. Collect ${threshold} signatures from owners: ${owners.join(", ")}`);
    console.log(`  4. Execute from any owner once the threshold is met`);
    console.log(`\nNo on-chain action taken by this script.`);
    return;
  }

  // Bootstrap (threshold=1): single-signer direct submit.
  const signature = await walletClient.signTypedData({
    account,
    domain: { chainId: BigInt(chainId), verifyingContract: safeAddress },
    types: SAFE_TX_TYPES,
    primaryType: "SafeTx",
    message: safeTx
  });

  console.log(`Sending execTransaction...`);
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
  if (receipt.status !== "success") throw new Error(`execTransaction reverted: ${txHash}`);
  console.log(`\nDone. block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
