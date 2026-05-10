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
  // REINIT_CALLDATA is the ABI-encoded full reinitializer call (selector + args).
  // For zero-arg reinits, this is the 4-byte selector. For parametrized
  // reinits, build via `cast calldata 'fn(args)' <args...>` and pass the
  // entire 0x-prefixed hex string. For a no-reinit upgrade, pass "0x" or
  // omit (defaults to empty bytes — equivalent to upgradeTo).
  //
  // REINIT_SIGNATURE is the legacy fallback used when REINIT_CALLDATA is
  // unset; it ONLY supports zero-arg signatures (e.g. "reinitialize()").
  // The script aborts if REINIT_SIGNATURE contains arguments and
  // REINIT_CALLDATA is missing — preventing the H-4 mega-review bug where
  // the script would silently truncate parametrized signatures to a
  // 4-byte selector and queue malformed Timelock calldata.
  const reinitCalldataRaw = process.env["REINIT_CALLDATA"];
  const reinitSignatureRaw = process.env["REINIT_SIGNATURE"]; // optional fallback
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

  // Resolve reinit calldata from REINIT_CALLDATA (preferred) or REINIT_SIGNATURE
  // (zero-arg fallback only). Empty bytes ("0x") = no reinitializer call.
  let reinitCalldata: Hex;
  if (reinitCalldataRaw !== undefined) {
    if (!/^0x[0-9a-fA-F]*$/.test(reinitCalldataRaw)) {
      throw new Error(`REINIT_CALLDATA must be 0x-prefixed hex; got "${reinitCalldataRaw}"`);
    }
    if (reinitCalldataRaw.length % 2 !== 0) {
      throw new Error(`REINIT_CALLDATA hex length odd; got ${reinitCalldataRaw.length}`);
    }
    reinitCalldata = reinitCalldataRaw as Hex;
    console.log(`Reinit calldata:  ${reinitCalldata} (${(reinitCalldata.length - 2) / 2} bytes)`);
  } else if (reinitSignatureRaw !== undefined) {
    // Legacy zero-arg fallback. Reject if signature contains arguments — passing
    // only the 4-byte selector for a parametrized fn produces malformed calldata.
    const argsMatch = reinitSignatureRaw.match(/\((.*)\)/);
    const argsList = argsMatch?.[1]?.trim() ?? "";
    if (argsList.length > 0) {
      throw new Error(
        `REINIT_SIGNATURE "${reinitSignatureRaw}" has arguments — set REINIT_CALLDATA ` +
          `to the full ABI-encoded calldata instead (build via cast calldata '${reinitSignatureRaw}' <args...>). ` +
          `Selector-only invocation of a parametrized reinitializer would queue malformed Timelock calldata (mega-review H-4).`
      );
    }
    reinitCalldata = keccak256(stringToBytes(reinitSignatureRaw)).slice(0, 10) as Hex;
    console.log(`Reinit signature: ${reinitSignatureRaw}`);
    console.log(`Reinit calldata:  ${reinitCalldata} (4-byte selector for zero-arg reinit)`);
  } else {
    reinitCalldata = "0x";
    console.log(`Reinit calldata:  0x (no reinitializer call — equivalent to upgradeTo)`);
  }

  // Mega-review M-2 — upgrade-candidate preflight. Reject the schedule if
  // the new implementation address is not a deployed contract, lacks the
  // ERC-1822 `proxiableUUID()` method, returns the wrong UUID, or — when
  // the operator passes `EXPECTED_IMPL_VERSION` — exposes a different
  // `implVersion()`. Catches the «schedule then revert on execute» class
  // of footguns the original mega-review flagged.
  const ERC1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
  const newImplCode = await publicClient.getCode({ address: newImplAddr });
  if (!newImplCode || newImplCode === "0x") {
    throw new Error(`NEW_IMPL_ADDRESS ${newImplAddr} has no runtime code on chainid ${chainId} — schedule would queue a revert.`);
  }
  console.log(`New impl code:    ${newImplCode.length / 2 - 1} bytes`);
  try {
    const uuid = (await publicClient.readContract({
      address: newImplAddr,
      abi: [{ type: "function", name: "proxiableUUID", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] }] as const,
      functionName: "proxiableUUID"
    })) as Hex;
    if (uuid.toLowerCase() !== ERC1967_IMPL_SLOT) {
      throw new Error(`proxiableUUID mismatch: got ${uuid}, expected ${ERC1967_IMPL_SLOT} (ERC-1967 impl slot). New impl is not UUPS-compatible.`);
    }
    console.log(`proxiableUUID:    ${uuid} ✓ matches ERC-1967 impl slot`);
  } catch (err) {
    throw new Error(`Preflight: failed to read proxiableUUID() on new impl ${newImplAddr}. Either it's not a UUPS impl or the call reverted. Underlying: ${(err as Error).message}`);
  }
  const expectedImplVersion = process.env["EXPECTED_IMPL_VERSION"];
  if (expectedImplVersion !== undefined) {
    const liveVersion = (await publicClient.readContract({
      address: newImplAddr,
      abi: [{ type: "function", name: "implVersion", stateMutability: "pure", inputs: [], outputs: [{ type: "string" }] }] as const,
      functionName: "implVersion"
    })) as string;
    if (liveVersion !== expectedImplVersion) {
      throw new Error(`implVersion mismatch: new impl returns "${liveVersion}", expected "${expectedImplVersion}". Refusing to schedule wrong-version upgrade.`);
    }
    console.log(`implVersion:      "${liveVersion}" ✓ matches EXPECTED_IMPL_VERSION`);
  } else {
    console.log(`implVersion:      (skipped — set EXPECTED_IMPL_VERSION to gate)`);
  }
  // Read current ERC-1967 impl slot for audit-trail in the manifest.
  const oldImplRaw = await publicClient.getStorageAt({ address: proxyAddr, slot: ERC1967_IMPL_SLOT });
  const oldImplAddr = oldImplRaw ? (`0x${oldImplRaw.slice(-40)}` as Address) : ("0x0000000000000000000000000000000000000000" as Address);
  console.log(`Current impl:     ${oldImplAddr} (from ERC-1967 slot of proxy)`);
  if (oldImplAddr.toLowerCase() === newImplAddr.toLowerCase()) {
    throw new Error(`No-op upgrade: NEW_IMPL_ADDRESS ${newImplAddr} == current impl ${oldImplAddr}. Aborting to avoid wasted Timelock cycle.`);
  }

  const upgradeCalldata = encodeFunctionData({
    abi: UPGRADE_ABI,
    functionName: "upgradeToAndCall",
    args: [newImplAddr, reinitCalldata]
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

  // Self-signer / multisig dual-mode (mega-review H-5). See safe-exec.ts
  // for the full design rationale. Bootstrap (threshold=1) submits
  // directly; production (threshold>=2) emits SafeTx + SafeTxHash for
  // operator upload to Safe Wallet UI and exits without on-chain action.
  const [threshold, owners, safeNonce] = await Promise.all([
    publicClient.readContract({ address: safeAddress, abi: SAFE_ABI, functionName: "getThreshold" }),
    publicClient.readContract({ address: safeAddress, abi: SAFE_ABI, functionName: "getOwners" }),
    publicClient.readContract({ address: safeAddress, abi: SAFE_ABI, functionName: "nonce" })
  ]);
  if (!owners.map((o) => o.toLowerCase()).includes(account.address.toLowerCase())) {
    throw new Error(`Signer not owner. Owners: ${owners.join(", ")}`);
  }
  const isBootstrap = threshold === 1n;

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

  if (!isBootstrap) {
    const { hashTypedData } = await import("viem");
    const safeTxHash = hashTypedData({
      domain: { chainId: BigInt(chainId), verifyingContract: safeAddress },
      types: SAFE_TX_TYPES,
      primaryType: "SafeTx",
      message: safeTx
    });
    console.log(`\n=== MULTISIG MODE (threshold=${threshold}) ===`);
    console.log(`Safe requires ${threshold} signatures. Script does NOT submit;`);
    console.log(`upload the SafeTx via Safe Wallet UI for owner co-signing.`);
    console.log(`\nSafeTx (Timelock.schedule wrapper):`);
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
    console.log(`\nSafeTxHash:       ${safeTxHash}`);
    console.log(`Operation ID:     ${opId}`);
    console.log(`Reinit calldata:  ${reinitCalldata}`);
    console.log(`Upgrade calldata: ${upgradeCalldata}`);
    console.log(`Schedule calldata: ${scheduleCalldata}`);
    console.log(`\nNext steps:`);
    console.log(`  1. https://app.safe.global/transactions/queue?safe=<chain>:${safeAddress}`);
    console.log(`  2. New tx → Contract interaction → target ${timelockAddr}`);
    console.log(`     calldata = the "data" field above (Timelock.schedule(...))`);
    console.log(`  3. Collect ${threshold} signatures from owners: ${owners.join(", ")}`);
    console.log(`  4. Execute from any owner; wait getMinDelay()=${delay}s; then`);
    console.log(`     run a follow-up script for Timelock.execute(...) (separate PR).`);
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
