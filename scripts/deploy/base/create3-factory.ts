// scripts/deploy/base/create3-factory.ts
//
// ZeframLou CREATE3 Factory (https://github.com/ZeframLou/create3-factory)
// bindings for ParkToken BSC deploy.
//
// The factory is deployed via Nick's method (keyless), so the same address is
// reachable on every EVM chain where it has been deployed.
//
// Address verification: each entry includes the expected runtime
// extcodehash. `verifyExtcodehash()` aborts if the on-chain bytecode at
// the registered address does not match — guard against substitution.
//
// Salt: `PARK_TOKEN_SALT` is the production salt. The CREATE3 address is a pure
// function of (factory, deployer, salt), so this constant — together with the
// deployer EOA and factory address — fully determines the deployed proxy
// address (see docs/DEPLOYMENTS.md for the live mainnet address). The salt is
// not a secret: it appears in the factory.deploy() calldata on-chain and only
// the original deployer can ever reach the derived address (msg.sender-prefix).
// Earlier pre-audit test deployments used the label `earnpark.parktoken.v1.proxy`;
// that address is archived and must not be reused.
//
// References:
//   - https://github.com/ZeframLou/create3-factory

import { keccak256, toHex, getContractAddress, encodePacked, type Hex } from "viem";
import type { PublicClient } from "viem";

export type SupportedChainKey = "bsc";

export interface Create3FactoryEntry {
  readonly chainId: number;
  readonly address: `0x${string}`;
  readonly expectedExtcodehash: `0x${string}`;
  readonly factoryVersion: "zeframlou-msg-sender-prefix";
}

// All addresses + extcodehashes verified on-chain at 2026-05-02 (bsc mainnet).
export const CREATE3_FACTORY_REGISTRY: Readonly<
  Record<SupportedChainKey, Create3FactoryEntry>
> = {
  bsc: {
    chainId: 56,
    address: "0x6aA3D87e99286946161dCA02B97C5806fC5eD46F",
    expectedExtcodehash:
      "0x00b17219fb16a322d231dc1830789d7936d3547bedd9feed313445001dc21e37",
    factoryVersion: "zeframlou-msg-sender-prefix"
  }
} as const;

export const PARK_TOKEN_SALT: Hex = keccak256(
  toHex("earnpark.parktoken.production.v1.proxy")
);

// ZeframLou (Solmate-based) with msg.sender prefix:
//   effectiveSalt = keccak256(deployer ++ userSalt)
//   proxyDeployer = keccak256(0xff ++ factory ++ effectiveSalt
//                              ++ keccak256(PROXY_INITCODE))[12..]
//   target        = keccak256(rlp(proxyDeployer, 1))[12..]
//
// Canonical 16-byte minimal-proxy initcode keccak — same value used by both
// Solady and Solmate CREATE3 libraries.
const PROXY_INITCODE_HASH: Hex =
  "0x21c35dbe1b344a2488cf3321d6ce542f8e9f305544ff09e4993a62319a497c1f";

export function computeProxyAddress(args: {
  factory: `0x${string}`;
  deployer: `0x${string}`;
  salt: Hex;
}): `0x${string}` {
  const effectiveSalt = keccak256(
    encodePacked(["address", "bytes32"], [args.deployer, args.salt])
  );
  const proxyDeployer = getContractAddress({
    bytecodeHash: PROXY_INITCODE_HASH,
    from: args.factory,
    opcode: "CREATE2",
    salt: effectiveSalt
  });
  return getContractAddress({ from: proxyDeployer, nonce: 1n });
}

/**
 * Verifies the on-chain runtime bytecode at `address` hashes to
 * `expectedExtcodehash`. Aborts if missing or mismatched. Use as a
 * pre-flight guard against substitution of trusted dependencies.
 */
export async function verifyExtcodehash(args: {
  client: Pick<PublicClient, "getCode">;
  address: `0x${string}`;
  expectedExtcodehash: Hex;
}): Promise<void> {
  const code = await args.client.getCode({ address: args.address });
  if (!code || code === "0x") {
    throw new Error(`verifyExtcodehash: no code at ${args.address}`);
  }
  const actual = keccak256(code);
  if (actual !== args.expectedExtcodehash.toLowerCase()) {
    throw new Error(
      `verifyExtcodehash: extcodehash mismatch at ${args.address} ` +
        `(expected ${args.expectedExtcodehash}, got ${actual})`
    );
  }
}
