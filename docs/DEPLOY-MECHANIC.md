# Deploy mechanic

The proxy is deployed via the **ZeframLou CREATE3 Factory** at
`0x6aA3D87e99286946161dCA02B97C5806fC5eD46F` (deployed on BSC, Eth mainnet, and 50+
EVM chains with identical extcodehash) rather than a plain `new ERC1967Proxy(impl,
calldata)`. The proxy address is deterministically derivable from `(factory, deployer,
salt)` and does **not** depend on `impl`'s init code — so a deploy on any other EVM chain
can produce the same proxy address even after compiler or submodule bumps.

---

## Three sequential transactions

### Tx 1 — Timelock deploy (plain CREATE)

Deploy `ParkTimelockController` (OZ `TimelockController` wrapper). The Timelock holds
`UPGRADER_ROLE` and `TIMELOCK_ADMIN_ROLE` on the proxy. Its `minDelay` governs the
mandatory wait between scheduling and executing any upgrade.

### Tx 2 — Implementation deploy (plain CREATE)

Deploy the `ParkToken` implementation contract (bare, no proxy). The constructor calls
`_disableInitializers()` so the impl cannot be initialised directly.

### Tx 3 — Proxy deploy (ZeframLou factory.deploy)

Call `factory.deploy(salt, initcode)` where:

- `salt = PARK_TOKEN_SALT` (defined in `scripts/deploy/base/create3-factory.ts`,
  computed once at module load via `keccak256(toHex("earnpark.parktoken.v1.proxy"))`)
- `initcode = ERC1967Proxy_creationCode ++ abi.encode(impl_address, initialize_calldata)`

The factory uses `effectiveSalt = keccak256(msg.sender ++ userSalt)` so the resulting
proxy address is keyed to the deployer. `initialize_calldata` is the ABI-encoded
`initialize(InitConfig)` call — the proxy constructor forwards it to the implementation
atomically.

---

## Salt invariant

The salt value above is committed to the project for life. Changing it forfeits the
deterministic-address property and requires manual coordination on every chain deployment.

---

## Factory trust

ZeframLou's factory is treated as a trusted dependency, analogous to OpenZeppelin
contracts. The deploy script verifies its on-chain bytecode hash via `verifyExtcodehash()`
before broadcasting any transaction. Mismatch aborts the deploy.

---

## Post-deploy assertions

`runPostDeployAssertions` verifies all of the following before writing the manifest:

1. `proxy address == predicted CREATE3 address`
2. `Timelock.getMinDelay() == configured timelockDelay`
3. `Safe holds DEFAULT_ADMIN_ROLE`
4. `Timelock holds UPGRADER_ROLE`
5. `Timelock holds TIMELOCK_ADMIN_ROLE`
6. `Rescuer holds RESCUER_ROLE`
7. `Safe does NOT hold TIMELOCK_ADMIN_ROLE`
8. `Safe does NOT hold UPGRADER_ROLE`
9. `getRoleAdmin(UPGRADER_ROLE) == TIMELOCK_ADMIN_ROLE`
10. `getRoleAdmin(TIMELOCK_ADMIN_ROLE) == self`
11. `cap() == 1_000_000_000 PARK`
12. `totalSupply() == cap()`
13. `balanceOf(initialHolder) == cap()`
14. `implVersion() == "base-1.0.0"`
15. `contractURI() == configured URI`

---

## Source verification on BscScan

`ParkToken.sol` (implementation) and `ParkTimelockController` are verified
via `npx hardhat verify --network bsc <address>` directly.

The **proxy contract** (`ParkERC1967Proxy` wrapper,
`contracts/imports/ERC1967ProxyImport.sol`) takes 2 constructor args:
`(address implementation, bytes _data)`. To verify on BscScan, compute the
ABI-encoded args:

```ts
import { encodeAbiParameters, parseAbiParameter } from "viem";
const args = encodeAbiParameters(
  [parseAbiParameter("address"), parseAbiParameter("bytes")],
  [IMPL_ADDRESS, INITIALIZE_CALLDATA]
);
console.log(args.slice(2)); // strip 0x for BscScan UI input
```

Where `INITIALIZE_CALLDATA` is the `initialize((address,uint48,address,address,address,string))`
calldata used at deploy time — re-encodable from the `InitConfig` struct documented in
`docs/TOKEN-SPEC.md`.

---

## Mark-as-proxy on the explorer (required after every fresh deploy)

Source verification (above) publishes the bytecode of the proxy stub
itself; it does NOT register the implementation pointer with the
explorer. Without registration, BscScan / Arbiscan render only the raw
proxy stub on the contract page — the «Read as Proxy» / «Write as Proxy»
tabs that expose `cap()`, `totalSupply()`, role views, `contractURI()`,
etc. via the implementation's ABI never appear.

For ERC1967 proxies deployed via OpenZeppelin's
TransparentUpgradeableProxyFactory, the explorer auto-recognises the
implementation and registers the proxy automatically. The ZeframLou
CREATE3 factory is NOT in that recognised set, so the auto-flow does not
fire and the proxy must be marked manually.

Use the Etherscan V2 unified API endpoint (one call per chain):

```bash
# BSC mainnet (chainid=56)
curl -X POST "https://api.etherscan.io/v2/api?chainid=56" \
  -d "module=contract" \
  -d "action=verifyproxycontract" \
  -d "address=$PROXY_ADDRESS" \
  -d "expectedimplementation=$IMPL_ADDRESS" \
  -d "apikey=$ETHERSCAN_V2_API_KEY"
# → returns {"status":"1","result":"<GUID>"}

# Wait ~10 s, then check status:
curl "https://api.etherscan.io/v2/api?chainid=56&module=contract&action=checkproxyverification&guid=<GUID>&apikey=$ETHERSCAN_V2_API_KEY"
# expected: {"status":"1","result":"The proxy's (...) implementation contract is found at ... and is successfully updated."}
```

`ETHERSCAN_V2_API_KEY` is a single API key that authenticates against
all V2-supported chains (BscScan, Etherscan, Arbiscan, etc.) — the
`chainid` query parameter routes the request. Repeat the call once per
chain on which the proxy is live.

After the call returns OK, open the proxy page in a browser and confirm
the «Read as Proxy» / «Write as Proxy» tabs render the implementation's
ABI (`name()`, `symbol()`, `cap()`, `hasRole(bytes32,address)`, …).

---

## Deterministic address derivation

The proxy address can be computed off-chain from:

```text
effectiveSalt = keccak256(deployer ++ userSalt)
proxyDeployer = CREATE2(factory, effectiveSalt, PROXY_INITCODE_HASH)[12..]
proxyAddress  = CREATE(proxyDeployer, nonce=1)[12..]
```

where `PROXY_INITCODE_HASH = 0x21c35dbe1b344a2488cf3321d6ce542f8e9f305544ff09e4993a62319a497c1f`
(canonical 16-byte minimal-proxy initcode, same as Solmate/Solady CREATE3).

The `computeProxyAddress` helper in `scripts/deploy/base/create3-factory.ts` implements
this derivation exactly.
