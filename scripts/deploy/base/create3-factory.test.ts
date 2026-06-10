import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256, type Hex, type PublicClient } from "viem";
import {
  CREATE3_FACTORY_REGISTRY,
  PARK_TOKEN_SALT,
  computeProxyAddress,
  verifyExtcodehash,
  type SupportedChainKey
} from "./create3-factory.js";

describe("create3-factory module", () => {
  it("exports a registry covering bsc", () => {
    const expected: SupportedChainKey[] = ["bsc"];
    for (const k of expected) {
      assert.ok(
        CREATE3_FACTORY_REGISTRY[k],
        `registry missing entry for ${k}`
      );
    }
  });

  it("exports the production PARK_TOKEN_SALT constant", () => {
    assert.equal(
      PARK_TOKEN_SALT,
      keccak256(Buffer.from("earnpark.parktoken.production.v1.proxy"))
    );
  });
});

describe("computeProxyAddress", () => {
  // Reference vector verified on-chain via factory.getDeployed() on BSC mainnet at 2026-05-02
  it("matches reference vector for ZeframLou factory + msg.sender prefix", () => {
    const factory = "0x6aA3D87e99286946161dCA02B97C5806fC5eD46F" as `0x${string}`;
    const deployer = "0x1111111111111111111111111111111111111111" as `0x${string}`;
    const salt = ("0x" + "22".repeat(32)) as `0x${string}`;
    const expected = "0xD8324D25b1Dc80387a1ACAa6Ed4d9B8645D60DDe";
    const actual = computeProxyAddress({ factory, deployer, salt });
    assert.equal(actual.toLowerCase(), expected.toLowerCase());
  });

  it("changes when salt changes (sanity)", () => {
    const factory = "0x000000000000F08DA62Cd1A14F31D5b39B7d4Adb" as `0x${string}`; // arbitrary address — these tests verify pure-formula properties, not on-chain state
    const deployer = "0x1111111111111111111111111111111111111111" as `0x${string}`;
    const a = computeProxyAddress({
      factory,
      deployer,
      salt: ("0x" + "00".repeat(32)) as `0x${string}`
    });
    const b = computeProxyAddress({
      factory,
      deployer,
      salt: ("0x" + "ff".repeat(32)) as `0x${string}`
    });
    assert.notEqual(a, b);
  });

  it("is deterministic for same inputs", () => {
    const factory = "0x000000000000F08DA62Cd1A14F31D5b39B7d4Adb" as `0x${string}`; // arbitrary address — these tests verify pure-formula properties, not on-chain state
    const deployer = "0x1111111111111111111111111111111111111111" as `0x${string}`;
    const salt = ("0x" + "33".repeat(32)) as `0x${string}`;
    const a = computeProxyAddress({ factory, deployer, salt });
    const b = computeProxyAddress({ factory, deployer, salt });
    assert.equal(a, b);
  });

  it("address changes when deployer changes (front-run protection)", () => {
    const factory = "0x000000000000F08DA62Cd1A14F31D5b39B7d4Adb" as `0x${string}`; // arbitrary address — these tests verify pure-formula properties, not on-chain state
    const salt = ("0x" + "22".repeat(32)) as `0x${string}`;
    const a = computeProxyAddress({
      factory,
      deployer: "0x1111111111111111111111111111111111111111" as `0x${string}`,
      salt
    });
    const b = computeProxyAddress({
      factory,
      deployer: "0x2222222222222222222222222222222222222222" as `0x${string}`,
      salt
    });
    assert.notEqual(a, b);
  });
});

describe("verifyExtcodehash", () => {
  it("accepts when on-chain extcodehash matches expected", async () => {
    const knownBytecode = ("0x6080" + "00".repeat(100)) as Hex;
    const expectedHash = keccak256(knownBytecode);
    const client = mockPublicClient({ code: knownBytecode });
    await verifyExtcodehash({
      client,
      address: "0x0000000000000000000000000000000000001234",
      expectedExtcodehash: expectedHash
    });
    // No throw == pass.
  });

  it("aborts when extcodehash differs", async () => {
    const client = mockPublicClient({ code: "0xdead" as Hex });
    await assert.rejects(
      verifyExtcodehash({
        client,
        address: "0x0000000000000000000000000000000000001234",
        expectedExtcodehash: ("0x" + "ab".repeat(32)) as Hex
      }),
      /extcodehash mismatch/i
    );
  });

  it("aborts when contract has no code", async () => {
    const client = mockPublicClient({ code: "0x" as Hex });
    await assert.rejects(
      verifyExtcodehash({
        client,
        address: "0x0000000000000000000000000000000000001234",
        expectedExtcodehash: ("0x" + "00".repeat(32)) as Hex
      }),
      /no code at/i
    );
  });
});

// Local test helper — mock public client returning a fixed `getCode`.
function mockPublicClient(opts: { code: Hex }): Pick<PublicClient, "getCode"> {
  return {
    getCode: async () => (opts.code === "0x" ? undefined : opts.code)
  };
}
