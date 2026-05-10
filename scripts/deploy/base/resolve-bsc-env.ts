// Shared environment resolver for BSC deploy scripts.
//
// Both deploy-bsc.ts and build-bsc-calldata.ts require the same set of BSC_*
// environment variables. Centralising validation here ensures both scripts
// stay in sync and reduces duplication.
//
// Exported as a pure function so it can be tested without side-effects.

export interface ResolvedBscEnv {
  defaultAdmin: string;
  // Empty string ("") when strict=false and BSC_RESCUER_ADDRESS is not set.
  // Always a valid non-admin address when strict=true.
  rescuer: string;
  initialHolder: string;
  timelockDelay: number;
  adminDelay: number;
  contractURI: string;
  // True when BSC_PRODUCTION_MODE=true. Tightens timelockDelay floor to
  // PRODUCTION_TIMELOCK_DELAY_MIN (21600s = 6 h) and obliges callers to run
  // additional Safe + role pre-broadcast checks (mega-review CertiK H-02).
  productionMode: boolean;
}

// Minimum Timelock minDelay (seconds) to be considered production-ready.
// 6 hours gives any holder a meaningful reaction window between Safe-side
// scheduling and on-chain execution. Less than this MUST not deploy under
// BSC_PRODUCTION_MODE=true.
export const PRODUCTION_TIMELOCK_DELAY_MIN = 21600;
// Minimum Safe threshold for production. 3-of-N matches the documented
// production-uplift policy (Safe 3/5 + Guardian 2/3).
export const PRODUCTION_SAFE_THRESHOLD_MIN = 3;
// Minimum Safe owner-set size at production. <5 owners with threshold=3 is
// possible but unwise (1-key compromise = 1/3 of threshold).
export const PRODUCTION_SAFE_OWNERS_MIN = 5;

export interface ResolveBscEnvOptions {
  // strict=true  (deploy-bsc.ts) — BSC_RESCUER_ADDRESS is REQUIRED and must
  //   differ from defaultAdmin. Missing or equal value aborts immediately.
  // strict=false (build-bsc-calldata.ts) — BSC_RESCUER_ADDRESS is optional;
  //   when absent, rescuer="" is returned and the calldata builder marks the
  //   output as PLACEHOLDER status.
  strict: boolean;
}

function isHexAddr(v: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

const ZERO = "0x0000000000000000000000000000000000000000";

export function resolveBscEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: ResolveBscEnvOptions = { strict: true }
): ResolvedBscEnv {
  const defaultAdmin = env["BSC_DEFAULT_ADMIN_ADDRESS"];
  if (!defaultAdmin) throw new Error("BSC_DEFAULT_ADMIN_ADDRESS not set (Safe address)");

  const rescuerRaw = env["BSC_RESCUER_ADDRESS"];
  const rescuerProvided = rescuerRaw !== undefined && rescuerRaw.trim() !== "";

  let rescuer: string;
  if (opts.strict) {
    // Deploy path: rescuer is mandatory and must differ from defaultAdmin.
    // ParkToken.initialize() reverts with DuplicateRoleAssignment when
    // rescuer == defaultAdmin, so defaulting is never safe here.
    if (!rescuerProvided) {
      throw new Error(
        "BSC_RESCUER_ADDRESS not set — required for deploy. " +
          "Must be a dedicated Safe address distinct from BSC_DEFAULT_ADMIN_ADDRESS."
      );
    }
    rescuer = rescuerRaw!.trim();
    if (rescuer.toLowerCase() === defaultAdmin.toLowerCase()) {
      throw new Error(
        "BSC_RESCUER_ADDRESS must differ from BSC_DEFAULT_ADMIN_ADDRESS " +
          "(ParkToken.initialize reverts on DuplicateRoleAssignment)"
      );
    }
  } else {
    // Calldata-builder path: rescuer is optional for offline preview.
    // Caller marks artefact PLACEHOLDER when rescuer is "".
    rescuer = rescuerProvided ? rescuerRaw!.trim() : "";
    // Even in lenient mode, explicitly providing a rescuer that equals
    // defaultAdmin is still an error — the contract will always reject it.
    if (rescuer !== "" && rescuer.toLowerCase() === defaultAdmin.toLowerCase()) {
      throw new Error(
        "BSC_RESCUER_ADDRESS must differ from BSC_DEFAULT_ADMIN_ADDRESS " +
          "(ParkToken.initialize reverts on DuplicateRoleAssignment)"
      );
    }
  }

  const initialHolderRaw = env["BSC_INITIAL_HOLDER"];
  const initialHolder = initialHolderRaw && initialHolderRaw.trim() !== "" ? initialHolderRaw : defaultAdmin;
  const timelockDelay = Number(env["BSC_TIMELOCK_DELAY_SECONDS"] ?? "21600");
  const adminDelay = Number(env["BSC_DEFAULT_ADMIN_TRANSFER_DELAY_SECONDS"] ?? "172800");
  const contractURI = env["BSC_CONTRACT_URI"] ?? "https://earnpark.com/token-metadata.json";

  // Validate all non-empty address fields.
  const addressFields: ReadonlyArray<readonly [string, string]> = [
    ["BSC_DEFAULT_ADMIN_ADDRESS", defaultAdmin],
    ...(rescuer !== "" ? [["BSC_RESCUER_ADDRESS", rescuer] as const] : []),
    ["BSC_INITIAL_HOLDER", initialHolder]
  ];
  for (const [name, value] of addressFields) {
    if (!isHexAddr(value)) {
      throw new Error(`${name}=${value} is not a 0x-prefixed 20-byte address`);
    }
    if (value.toLowerCase() === ZERO) throw new Error(`${name} is the zero address`);
  }

  if (!Number.isFinite(timelockDelay) || timelockDelay < 60) {
    throw new Error(`BSC_TIMELOCK_DELAY_SECONDS=${timelockDelay} invalid (must be ≥ 60s)`);
  }
  if (!Number.isFinite(adminDelay) || adminDelay < 86_400 || adminDelay > 2_592_000) {
    throw new Error(
      `BSC_DEFAULT_ADMIN_TRANSFER_DELAY_SECONDS=${adminDelay} outside [86400, 2592000]`
    );
  }

  // Production-mode hard gate (CertiK pre-audit H-02). Set BSC_PRODUCTION_MODE=true
  // for any deploy that intends to be load-bearing for TGE / CEX / public
  // distribution. Bootstrap rehearsals (Safe 1/1, 900 s Timelock) MUST keep
  // it unset / false. The flag is fail-closed on the timelock floor here;
  // additional Safe-shape checks fire pre-broadcast in deploy-bsc.ts.
  const productionModeRaw = (env["BSC_PRODUCTION_MODE"] ?? "false").trim().toLowerCase();
  if (productionModeRaw !== "true" && productionModeRaw !== "false") {
    throw new Error(
      `BSC_PRODUCTION_MODE="${productionModeRaw}" invalid; set to "true" or "false" (default).`
    );
  }
  const productionMode = productionModeRaw === "true";
  if (productionMode && timelockDelay < PRODUCTION_TIMELOCK_DELAY_MIN) {
    throw new Error(
      `BSC_PRODUCTION_MODE=true requires BSC_TIMELOCK_DELAY_SECONDS >= ${PRODUCTION_TIMELOCK_DELAY_MIN} ` +
        `(6 h). Got ${timelockDelay}. Bootstrap delays (e.g. 900 s) are explicitly REJECTED ` +
        `under production mode to prevent staging-config drift into a real deploy.`
    );
  }

  return {
    defaultAdmin,
    rescuer,
    initialHolder,
    timelockDelay,
    adminDelay,
    contractURI,
    productionMode
  };
}
