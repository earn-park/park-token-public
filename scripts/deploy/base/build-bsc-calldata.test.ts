import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFileSync, existsSync, unlinkSync} from "node:fs";
import {join} from "node:path";

function run(overrides: Record<string, string>): {code: number; stdout: string; stderr: string} {
  const proc = spawnSync(
    "node",
    ["--import", "tsx", "scripts/deploy/base/build-bsc-calldata.ts"],
    {
      env: {
        ...process.env,
        // Override BSC_* env vars with empty strings so dotenv cannot
        // re-populate them from .env in the subprocess (dotenv skips
        // vars that are already set, even to "").
        BSC_DEFAULT_ADMIN_ADDRESS: "",
        BSC_RESCUER_ADDRESS: "",
        BSC_INITIAL_HOLDER: "",
        BSC_TIMELOCK_DELAY_SECONDS: "",
        // Set a valid adminDelay so it doesn't mask the error under test.
        BSC_DEFAULT_ADMIN_TRANSFER_DELAY_SECONDS: "172800",
        BSC_CONTRACT_URI: "",
        BSC_UPGRADER_ADDRESS: "",
        BSC_DEPLOYER_ADDRESS: "",
        BSC_RPC_URL: "",
        BSC_PRIVATE_KEY: "",
        TARGET_CHAIN: "bsc",
        ...overrides
      } as NodeJS.ProcessEnv,
      encoding: "utf8"
    }
  );
  return {code: proc.status ?? -1, stdout: proc.stdout, stderr: proc.stderr};
}

function readCalldataArtefact(chainKey = "bsc"): Record<string, unknown> {
  const p = join(process.cwd(), `ops/210-base-init-calldata-${chainKey}.json`);
  if (!existsSync(p)) throw new Error(`Artefact not found: ${p}`);
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

function cleanCalldataArtefact(chainKey = "bsc"): void {
  const p = join(process.cwd(), `ops/210-base-init-calldata-${chainKey}.json`);
  if (existsSync(p)) unlinkSync(p);
}

describe("build-bsc-calldata env validation", () => {
  it("aborts when BSC_DEFAULT_ADMIN_ADDRESS missing", () => {
    const {code, stderr} = run({});
    assert.notEqual(code, 0);
    assert.match(stderr, /BSC_DEFAULT_ADMIN_ADDRESS/);
  });

  it("does not abort when BSC_RESCUER_ADDRESS is omitted (offline preview — PLACEHOLDER artefact)", () => {
    // Calldata builder uses strict=false: missing rescuer produces a PLACEHOLDER
    // artefact (exit 0) and no BSC_RESCUER_ADDRESS error appears in stderr.
    cleanCalldataArtefact();
    const {code, stderr} = run({
      BSC_DEFAULT_ADMIN_ADDRESS: "0x" + "11".repeat(20),
      BSC_TIMELOCK_DELAY_SECONDS: "900"
    });
    assert.equal(code, 0, `Expected exit 0 but got ${code}. stderr: ${stderr}`);
    assert.doesNotMatch(stderr, /BSC_RESCUER_ADDRESS not set/);
    // Artefact must be written as PLACEHOLDER with the initialize selector.
    const artefact = readCalldataArtefact();
    assert.match(String(artefact["artefactStatus"]), /PLACEHOLDER/);
    // initialize selector: first 4 bytes of keccak256(initialize((address,uint48,address,address,address,string)))
    // = 0x14bf9d35
    assert.match(String(artefact["initializeFunctionSelector"]), /^0x14bf9d35$/i);
    // The "rescuer" field in the placeholder must not be a real hex address
    const cfg = artefact["initConfigHumanReadable"] as Record<string, string>;
    const rescuerField = cfg["rescuer"] ?? "";
    assert.match(rescuerField, /RESCUER_ADDRESS/);
    cleanCalldataArtefact();
  });

  it("aborts when admin equals rescuer", () => {
    const ADDR = "0x" + "11".repeat(20);
    const {code, stderr} = run({
      BSC_DEFAULT_ADMIN_ADDRESS: ADDR,
      BSC_RESCUER_ADDRESS: ADDR
    });
    assert.notEqual(code, 0);
    assert.match(stderr, /must differ from BSC_DEFAULT_ADMIN_ADDRESS/);
  });

  it("aborts when timelock delay invalid", () => {
    const {code, stderr} = run({
      BSC_DEFAULT_ADMIN_ADDRESS: "0x" + "11".repeat(20),
      BSC_RESCUER_ADDRESS: "0x" + "22".repeat(20),
      BSC_TIMELOCK_DELAY_SECONDS: "0"
    });
    assert.notEqual(code, 0);
    assert.match(stderr, /BSC_TIMELOCK_DELAY_SECONDS=0/);
  });
});
