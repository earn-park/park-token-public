import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  computePredictedAddress,
  preClaimSafetyCheck,
  encodeFactoryInitcode,
  encodeInitializeCalldata,
  runPostDeployAssertions,
  buildManifest,
  type PostDeployAssertionArgs
} from "./deploy-bsc.js";
import { type Hex } from "viem";

function run(overrides: Record<string, string>): { code: number; stderr: string } {
  const proc = spawnSync(
    "node",
    ["--import", "tsx", "scripts/deploy/base/deploy-bsc.ts"],
    {
      env: {
        ...process.env,
        // Override BSC_* env vars with empty strings so dotenv cannot
        // re-populate them from .env in the subprocess (dotenv skips
        // vars that are already set, even to "").
        BSC_DEFAULT_ADMIN_ADDRESS: "",
        BSC_RESCUER_ADDRESS: "",
        // BSC_INITIAL_HOLDER intentionally omitted: resolveEnv defaults it to
        // defaultAdmin, so tests that set defaultAdmin don't hit an unrelated
        // validation error from a bad initialHolder.
        BSC_TIMELOCK_DELAY_SECONDS: "",
        BSC_DEFAULT_ADMIN_TRANSFER_DELAY_SECONDS: "",
        BSC_CONTRACT_URI: "",
        BSC_RPC_URL: "",
        BSC_PRIVATE_KEY: "",
        TARGET_CHAIN: "bsc",
        ...overrides
      } as NodeJS.ProcessEnv,
      encoding: "utf8"
    }
  );
  return { code: proc.status ?? -1, stderr: proc.stderr };
}

describe("deploy-bsc env validation", () => {
  it("aborts when BSC_DEFAULT_ADMIN_ADDRESS missing", () => {
    const { code, stderr } = run({});
    assert.notEqual(code, 0);
    assert.match(stderr, /BSC_DEFAULT_ADMIN_ADDRESS not set/);
  });

  it("aborts when BSC_RESCUER_ADDRESS is omitted (required for deploy)", () => {
    // In strict mode (deploy path), rescuer is mandatory.
    // ParkToken.initialize() reverts on DuplicateRoleAssignment when
    // rescuer == defaultAdmin, so defaulting is never safe here.
    const { code, stderr } = run({
      BSC_DEFAULT_ADMIN_ADDRESS: "0x" + "11".repeat(20),
      BSC_TIMELOCK_DELAY_SECONDS: "900",
      BSC_DEFAULT_ADMIN_TRANSFER_DELAY_SECONDS: "86400"
    });
    assert.notEqual(code, 0);
    assert.match(stderr, /BSC_RESCUER_ADDRESS not set/);
  });

  it("aborts when admin equals rescuer", () => {
    const ADDR = "0x" + "11".repeat(20);
    const { code, stderr } = run({
      BSC_DEFAULT_ADMIN_ADDRESS: ADDR,
      BSC_RESCUER_ADDRESS: ADDR
    });
    assert.notEqual(code, 0);
    assert.match(stderr, /must differ from BSC_DEFAULT_ADMIN_ADDRESS/);
  });

  it("aborts when timelock delay invalid", () => {
    const { code, stderr } = run({
      BSC_DEFAULT_ADMIN_ADDRESS: "0x" + "11".repeat(20),
      BSC_RESCUER_ADDRESS: "0x" + "22".repeat(20),
      BSC_TIMELOCK_DELAY_SECONDS: "0"
    });
    assert.notEqual(code, 0);
    assert.match(stderr, /BSC_TIMELOCK_DELAY_SECONDS=0/);
  });
});

describe("computePredictedAddress", () => {
  it("returns the verified ZeframLou getDeployed result for known vector on BSC", () => {
    const a = computePredictedAddress({
      chainKey: "bsc",
      deployer: "0x1111111111111111111111111111111111111111"
    });
    const b = computePredictedAddress({
      chainKey: "bsc",
      deployer: "0x1111111111111111111111111111111111111111"
    });
    assert.equal(a, b); // deterministic
    assert.match(a, /^0x[0-9a-fA-F]{40}$/);
  });

  it("returns different addresses for different deployers", () => {
    const a = computePredictedAddress({
      chainKey: "bsc",
      deployer: "0x1111111111111111111111111111111111111111"
    });
    const b = computePredictedAddress({
      chainKey: "bsc",
      deployer: "0x2222222222222222222222222222222222222222"
    });
    assert.notEqual(a, b);
  });
});

describe("preClaimSafetyCheck", () => {
  it("aborts when target address already has code", async () => {
    // Use a known well-deployed BSC address (WBNB) to simulate occupied target.
    // This requires BSC RPC; skip if not configured.
    const rpcUrl = process.env["BSC_RPC_URL"];
    if (!rpcUrl) return; // skip silently if no RPC
    await assert.rejects(
      preClaimSafetyCheck({
        rpcUrl,
        chainKey: "bsc",
        predicted: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" // WBNB
      }),
      /already has code/
    );
  });

  it("passes when target address is empty (random vanity)", async () => {
    const rpcUrl = process.env["BSC_RPC_URL"];
    if (!rpcUrl) return; // skip silently if no RPC
    await preClaimSafetyCheck({
      rpcUrl,
      chainKey: "bsc",
      predicted: "0x0000000000000000000000000000000000DeAd99" // never deployed
    });
    // No throw == pass
  });
});

describe("encodeFactoryInitcode", () => {
  it("concatenates creationCode + abi.encode(impl, initializeCalldata)", () => {
    const creationCode = "0xdeadbeef" as Hex;
    const impl = "0x1111111111111111111111111111111111111111" as `0x${string}`;
    const initializeCalldata = "0xfeed" as Hex;

    const result = encodeFactoryInitcode({
      erc1967ProxyCreationCode: creationCode,
      impl,
      initializeCalldata
    });

    // Result must START with creationCode hex
    assert.ok(result.startsWith("0xdeadbeef"));
    // Result must be longer than creationCode (the appended abi-encoded data)
    assert.ok(result.length > "0xdeadbeef".length);
    // Result must contain the impl address (lowercase, padded) somewhere in the abi-encoded tail
    assert.match(result.toLowerCase(), /1111111111111111111111111111111111111111/);
  });
});

describe("encodeInitializeCalldata", () => {
  it("encodes the initialize(InitConfig) calldata with all 6 fields", () => {
    const result = encodeInitializeCalldata({
      defaultAdmin: "0x1111111111111111111111111111111111111111",
      defaultAdminTransferDelay: 172800,
      upgrader: "0x2222222222222222222222222222222222222222",
      rescuer: "0x3333333333333333333333333333333333333333",
      initialHolder: "0x4444444444444444444444444444444444444444",
      initialContractURI: "https://earnpark.com/token-metadata.json"
    });

    // Selector for initialize((address,uint48,address,address,address,string))
    // is the first 4 bytes — should not be 0x00000000.
    assert.ok(result.startsWith("0x"));
    assert.notEqual(result.slice(0, 10), "0x00000000");

    // The encoded calldata must contain each address (lowercase) in the body
    assert.match(result.toLowerCase(), /1111111111111111111111111111111111111111/);
    assert.match(result.toLowerCase(), /2222222222222222222222222222222222222222/);
    assert.match(result.toLowerCase(), /3333333333333333333333333333333333333333/);
    assert.match(result.toLowerCase(), /4444444444444444444444444444444444444444/);
  });

  it("produces different calldata for different admin delay", () => {
    const a = encodeInitializeCalldata({
      defaultAdmin: "0x1111111111111111111111111111111111111111",
      defaultAdminTransferDelay: 86400,
      upgrader: "0x2222222222222222222222222222222222222222",
      rescuer: "0x3333333333333333333333333333333333333333",
      initialHolder: "0x4444444444444444444444444444444444444444",
      initialContractURI: ""
    });
    const b = encodeInitializeCalldata({
      defaultAdmin: "0x1111111111111111111111111111111111111111",
      defaultAdminTransferDelay: 172800,
      upgrader: "0x2222222222222222222222222222222222222222",
      rescuer: "0x3333333333333333333333333333333333333333",
      initialHolder: "0x4444444444444444444444444444444444444444",
      initialContractURI: ""
    });
    assert.notEqual(a, b);
  });
});

describe("runPostDeployAssertions", () => {
  it("aborts when proxy address does not match predicted", async () => {
    // Mock publicClient that returns a fixed role set — never reached due to early throw.
    const mockPublicClient = {
      readContract: async () => {
        throw new Error("should not be called");
      }
    } as unknown as PostDeployAssertionArgs["publicClient"];

    await assert.rejects(
      runPostDeployAssertions({
        publicClient: mockPublicClient,
        proxyAddress: "0xAAAA000000000000000000000000000000000001",
        predictedAddress: "0xBBBB000000000000000000000000000000000001",
        timelockAddress: "0xDDDD000000000000000000000000000000000001",
        defaultAdmin: "0xEEEE000000000000000000000000000000000001",
        rescuer: "0xFFFF000000000000000000000000000000000001",
        initialHolder: "0xEEEE000000000000000000000000000000000001",
        deployer: "0x1111111111111111111111111111111111111111",
        expectedTimelockDelay: 900,
        expectedContractURI: "https://earnpark.com/token-metadata.json"
      }),
      /Predicted address mismatch/
    );
  });

  it("accepts case-mismatched but byte-equal addresses and passes all role checks", async () => {
    // Use REAL UPGRADER_ROLE hash to avoid collision with PROPOSER_ROLE
    // (PROPOSER_ROLE = 0xb09aa5ae... which the prior fixture incorrectly
    // reused as a placeholder UPGRADER hash).
    const upgraderRole =
      "0x189ab7a9244df0848122154315af71fe140f3db0fe014031783b0946b8c9d2e3" as Hex;
    const timelockAdminRole =
      "0x5f58e3a2316349923ce3780f8d587db2d72378aed66a8261c916544fa6846ca5" as Hex;
    const rescuerRole =
      "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex;

    const defaultAdmin = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as `0x${string}`;
    const timelockAddress = "0xdddddddddddddddddddddddddddddddddddddddd" as `0x${string}`;
    const deployer = "0x1111111111111111111111111111111111111111" as `0x${string}`;
    // OZ TimelockController role hashes (constants — match deploy-bsc.ts).
    const PROPOSER_ROLE =
      "0xb09aa5aeb3702cfd50b6b62bc4532604938f21248a27a1d5ca736082b6819cc1" as Hex;
    const EXECUTOR_ROLE =
      "0xd8aa0f3194971a2a116679f7c2090f6939c8d4e01a2a8d7e41d55e5351469e63" as Hex;
    const CANCELLER_ROLE =
      "0xfd643c72710c63c0180259aba6b2d05451e3591a24e58b62239378085726f783" as Hex;
    const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as `0x${string}`;
    const rescuer = "0xffffffffffffffffffffffffffffffffffffffff" as `0x${string}`;
    const defaultAdminRole = `0x${"00".repeat(32)}` as Hex;

    // Simulate viem readContract calls by name (functionName is in the call args).
    // We build a mock that inspects the `args` field to route responses.
    const mockPublicClient = {
      readContract: async (params: {
        functionName: string;
        args?: unknown[];
      }): Promise<unknown> => {
        if (params.functionName === "UPGRADER_ROLE") return upgraderRole;
        if (params.functionName === "TIMELOCK_ADMIN_ROLE") return timelockAdminRole;
        if (params.functionName === "RESCUER_ROLE") return rescuerRole;
        if (params.functionName === "getMinDelay") return 900n;
        if (params.functionName === "hasRole") {
          const [role, account] = params.args as [string, string];
          const a = account.toLowerCase();
          // ParkToken roles
          if (role === defaultAdminRole && a === defaultAdmin) return true;
          if (role === upgraderRole && a === timelockAddress) return true;
          if (role === timelockAdminRole && a === timelockAddress) return true;
          if (role === rescuerRole && a === rescuer) return true;
          // Timelock-internal roles
          if (role === PROPOSER_ROLE && a === defaultAdmin) return true;
          if (role === CANCELLER_ROLE && a === defaultAdmin) return true;
          if (role === EXECUTOR_ROLE && a === ZERO_ADDR) return true;
          if (role === defaultAdminRole && a === timelockAddress) return true;
          // Negative: deployer must NOT have DEFAULT_ADMIN_ROLE on Timelock
          if (role === defaultAdminRole && a === deployer) return false;
          return false;
        }
        if (params.functionName === "getRoleAdmin") {
          const [role] = params.args as [string];
          if (
            role.toLowerCase() === upgraderRole.toLowerCase() ||
            role.toLowerCase() === timelockAdminRole.toLowerCase()
          ) {
            return timelockAdminRole;
          }
          return defaultAdminRole;
        }
        // Token state assertions added to runPostDeployAssertions.
        const EXPECTED_CAP = 1_000_000_000n * 10n ** 6n;
        if (params.functionName === "cap") return EXPECTED_CAP;
        if (params.functionName === "totalSupply") return EXPECTED_CAP;
        if (params.functionName === "balanceOf") return EXPECTED_CAP;
        if (params.functionName === "implVersion") return "v1.0.0";
        if (params.functionName === "contractURI") return "https://earnpark.com/token-metadata.json";
        throw new Error(`Unexpected readContract call: ${params.functionName}`);
      },
      // EAA-02: a healthy proxy reverts InvalidInitialization() on re-init.
      // Surface the selector so the fallback match in runPostDeployAssertions fires.
      simulateContract: async (): Promise<unknown> => {
        throw new Error("execution reverted, custom error 0xf92ee8a9");
      }
    } as unknown as PostDeployAssertionArgs["publicClient"];

    // Same address in different case — must not trigger mismatch error.
    await runPostDeployAssertions({
      publicClient: mockPublicClient,
      proxyAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      predictedAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      timelockAddress,
      defaultAdmin,
      rescuer,
      initialHolder: defaultAdmin,
      deployer,
      expectedTimelockDelay: 900,
      expectedContractURI: "https://earnpark.com/token-metadata.json"
    });
    // No throw == pass
  });
});

describe("runPostDeployAssertions EAA-02 init-guard", () => {
  // All token-state + role reads return healthy values; only simulateContract
  // (the re-initialize probe) varies per branch.
  const defaultAdmin = "0xdddd000000000000000000000000000000000001";
  const rescuer = "0xeeee000000000000000000000000000000000001";
  const timelockAddress = "0xcccc000000000000000000000000000000000001";
  const deployer = "0x1111111111111111111111111111111111111111";
  const upgraderRole = "0x189ab7a9244df0848122154315af71fe140f3db0fe014031783b0946b8c9d2e3" as Hex;
  const timelockAdminRole = "0x5f58e3a2316349923ce3780f8d587db2d72378aed66a8261c916544fa6846ca5" as Hex;
  const rescuerRole = "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex;
  const defaultAdminRole = ("0x" + "00".repeat(32)) as Hex;
  // OZ TimelockController role hashes (constants — match deploy-bsc.ts).
  const PROPOSER_ROLE = "0xb09aa5aeb3702cfd50b6b62bc4532604938f21248a27a1d5ca736082b6819cc1" as Hex;
  const EXECUTOR_ROLE = "0xd8aa0f3194971a2a116679f7c2090f6939c8d4e01a2a8d7e41d55e5351469e63" as Hex;
  const CANCELLER_ROLE = "0xfd643c72710c63c0180259aba6b2d05451e3591a24e58b62239378085726f783" as Hex;
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  const EXPECTED_CAP = 1_000_000_000n * 10n ** 6n;

  function makeClient(simulate: () => Promise<unknown>): PostDeployAssertionArgs["publicClient"] {
    return {
      readContract: async (params: { functionName: string; args?: unknown[] }): Promise<unknown> => {
        if (params.functionName === "UPGRADER_ROLE") return upgraderRole;
        if (params.functionName === "TIMELOCK_ADMIN_ROLE") return timelockAdminRole;
        if (params.functionName === "RESCUER_ROLE") return rescuerRole;
        if (params.functionName === "getMinDelay") return 900n;
        if (params.functionName === "hasRole") {
          const [role, account] = params.args as [string, string];
          const a = account.toLowerCase();
          if (role === defaultAdminRole && a === defaultAdmin) return true;
          if (role === upgraderRole && a === timelockAddress) return true;
          if (role === timelockAdminRole && a === timelockAddress) return true;
          if (role === rescuerRole && a === rescuer) return true;
          if (role === PROPOSER_ROLE && a === defaultAdmin) return true;
          if (role === CANCELLER_ROLE && a === defaultAdmin) return true;
          if (role === EXECUTOR_ROLE && a === ZERO_ADDR) return true;
          if (role === defaultAdminRole && a === timelockAddress) return true;
          return false;
        }
        if (params.functionName === "getRoleAdmin") {
          const [role] = params.args as [string];
          if (
            role.toLowerCase() === upgraderRole.toLowerCase() ||
            role.toLowerCase() === timelockAdminRole.toLowerCase()
          ) {
            return timelockAdminRole;
          }
          return defaultAdminRole;
        }
        if (params.functionName === "cap") return EXPECTED_CAP;
        if (params.functionName === "totalSupply") return EXPECTED_CAP;
        if (params.functionName === "balanceOf") return EXPECTED_CAP;
        if (params.functionName === "implVersion") return "v1.0.0";
        if (params.functionName === "contractURI") return "https://earnpark.com/token-metadata.json";
        throw new Error(`Unexpected readContract call: ${params.functionName}`);
      },
      simulateContract: simulate
    } as unknown as PostDeployAssertionArgs["publicClient"];
  }

  const baseArgs = {
    proxyAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
    predictedAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as Hex,
    timelockAddress: timelockAddress as Hex,
    defaultAdmin: defaultAdmin as Hex,
    rescuer: rescuer as Hex,
    initialHolder: defaultAdmin as Hex,
    deployer: deployer as Hex,
    expectedTimelockDelay: 900,
    expectedContractURI: "https://earnpark.com/token-metadata.json"
  };

  it("PASS: re-initialize reverts InvalidInitialization (selector fallback)", async () => {
    const client = makeClient(async () => {
      throw new Error("execution reverted, custom error 0xf92ee8a9");
    });
    await runPostDeployAssertions({ publicClient: client, ...baseArgs });
    // no throw == initializer consumed
  });

  it("FAIL: re-initialize reverts with a NON-guard error (initializer may be open)", async () => {
    const client = makeClient(async () => {
      throw new Error("execution reverted, custom error 0xdeadbeef DuplicateRoleAssignment");
    });
    await assert.rejects(() => runPostDeployAssertions({ publicClient: client, ...baseArgs }), /NON-guard error/);
  });

  it("FAIL: re-initialize does NOT revert (initializer still callable)", async () => {
    const client = makeClient(async () => ({ request: {}, result: undefined }));
    await assert.rejects(
      () => runPostDeployAssertions({ publicClient: client, ...baseArgs }),
      /did NOT revert post-deploy/
    );
  });
});

describe("buildManifest", () => {
  // Default fixture is "all production gates passed".
  const baseArgs = {
    chainKey: "bsc" as const,
    chainId: 56,
    proxyAddress: "0xAAAA000000000000000000000000000000000001",
    implementationAddress: "0xBBBB000000000000000000000000000000000001",
    timelockAddress: "0xCCCC000000000000000000000000000000000001",
    timelockDelay: 21600,
    adminDelay: 172800,
    defaultAdmin: "0xDDDD000000000000000000000000000000000001",
    rescuer: "0xEEEE000000000000000000000000000000000001",
    initialHolder: "0xFFFF000000000000000000000000000000000001",
    initialContractURI: "https://earnpark.com/token-metadata.json",
    deployer: "0x1111111111111111111111111111111111111111",
    deploymentBlock: 12345678,
    predictedAddress: "0xAAAA000000000000000000000000000000000001",
    productionMode: true,
    expectedDeployerSet: true,
    expectedProxySet: true,
    expectedInitialHolderSet: true,
    safeShapeValidated: true,
    reproVerified: true,
    monitoringInstantiated: true,
    explorerProxyRegistered: true
  };

  it("produces production-ready manifest when ALL gates pass", () => {
    const m = buildManifest({ ...baseArgs, timelockDelay: 21600 });
    assert.equal(m.versionLabel, "v1.0.0");
    assert.equal(m.deploymentMode, "production");
    assert.equal(m.timelockDelayMeetsProductionFloor, true);
    assert.equal(m.productionReady, true);
    assert.equal(m.governanceUpgradePending, false);
    assert.deepEqual(m.pendingGovernanceActions, []);
  });

  it("productionReady=false when timelockDelay < 21600 (delay-floor gate fails)", () => {
    const m = buildManifest({ ...baseArgs, timelockDelay: 900 });
    assert.equal(m.timelockDelayMeetsProductionFloor, false);
    assert.equal(m.productionReady, false);
    assert.equal(m.productionGates.timelockDelayMeetsFloor.passed, false);
    assert.equal(m.governanceUpgradePending, true);
  });

  it("productionReady=false when productionMode=false (deploymentMode=staging)", () => {
    const m = buildManifest({ ...baseArgs, productionMode: false });
    assert.equal(m.deploymentMode, "staging");
    assert.equal(m.productionReady, false);
    assert.equal(m.productionGates.productionModeFlag.passed, false);
  });

  it("productionReady=false when initial-holder pin missing", () => {
    const m = buildManifest({ ...baseArgs, expectedInitialHolderSet: false });
    assert.equal(m.productionReady, false);
    assert.equal(m.productionGates.expectedInitialHolderPinned.passed, false);
  });

  it("productionReady=false when monitoring not yet attested", () => {
    const m = buildManifest({ ...baseArgs, monitoringInstantiated: false });
    assert.equal(m.productionReady, false);
    assert.equal(m.productionGates.monitoringInstantiated.passed, false);
  });

  it("includes CREATE3 fields (salt, factoryAddress, factoryExtcodehash, factoryVersion, predictedAddress)", () => {
    const m = buildManifest(baseArgs);
    assert.match(m.salt, /^0x[0-9a-f]{64}$/);
    assert.equal(m.factoryAddress, "0x6aA3D87e99286946161dCA02B97C5806fC5eD46F");
    assert.equal(
      m.factoryExtcodehash,
      "0x00b17219fb16a322d231dc1830789d7936d3547bedd9feed313445001dc21e37"
    );
    assert.equal(m.factoryVersion, "zeframlou-msg-sender-prefix");
    assert.equal(m.predictedAddress, baseArgs.predictedAddress);
  });

  it("upgrader equals timelockAddress (Timelock holds UPGRADER_ROLE)", () => {
    const m = buildManifest(baseArgs);
    assert.equal(m.upgrader, baseArgs.timelockAddress);
  });
});
