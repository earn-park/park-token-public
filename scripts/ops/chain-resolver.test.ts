import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveChain } from "./chain-resolver.js";

describe("resolveChain", () => {
  it("returns bsc viem object for TARGET_CHAIN=bsc", () => {
    const r = resolveChain({ TARGET_CHAIN: "bsc" });
    assert.equal(r.chain.id, 56);
    assert.equal(r.rpcEnvName, "BSC_RPC_URL");
    assert.equal(r.privateKeyEnvName, "BSC_PRIVATE_KEY");
    assert.equal(r.safeTxServiceUrl, "https://safe-transaction-bsc.safe.global");
  });

  it("rejects unknown TARGET_CHAIN (including arbitrum)", () => {
    assert.throws(() => resolveChain({ TARGET_CHAIN: "arbitrum" }), /Unsupported chain/);
  });

  it("rejects unknown TARGET_CHAIN (arbitrary string)", () => {
    assert.throws(() => resolveChain({ TARGET_CHAIN: "foo" }), /Unsupported chain/);
  });

  it("rejects missing TARGET_CHAIN", () => {
    assert.throws(() => resolveChain({}), /TARGET_CHAIN not set/);
  });
});
