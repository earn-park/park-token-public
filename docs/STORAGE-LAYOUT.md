# Storage layout

`ParkToken` uses ERC-7201 namespaced storage exclusively. There are no legacy
`uint256[50] __gap` arrays. Each namespace owns a fixed slot that does not depend on
the contract's position in the inheritance linearization.

---

## ParkToken-owned namespace

| Namespace | Slot | Struct |
|---|---|---|
| `earnpark.storage.ParkToken.Metadata` | `0x2c6f79634877d4fe165c547185a8e0ef04f5e43f93083c43ee2d9f6afee57d00` | `MetadataStorage { string contractURI; }` |

Slot derivation (ERC-7201 canonical formula):

```text
slot = keccak256(abi.encode(uint256(keccak256("earnpark.storage.ParkToken.Metadata")) - 1))
       & ~bytes32(uint256(0xff))
```

Verified by the regression test `test_metadataNamespaceSlot_matchesERC7201` in
`test/ParkToken.t.sol`.

---

## Inherited OpenZeppelin namespaces

| Namespace | Owner contract |
|---|---|
| `openzeppelin.storage.Initializable` | `Initializable` |
| `openzeppelin.storage.ERC20` | `ERC20Upgradeable` |
| `openzeppelin.storage.ERC20Capped` | `ERC20CappedUpgradeable` |
| `openzeppelin.storage.AccessControl` | `AccessControlUpgradeable` |
| `openzeppelin.storage.AccessControlDefaultAdminRules` | `AccessControlDefaultAdminRulesUpgradeable` |
| `openzeppelin.storage.EIP712` | `EIP712Upgradeable` |
| `openzeppelin.storage.Nonces` | `NoncesUpgradeable` |

None of these overlap with the `earnpark.storage.*` namespace.

---

## Notes

- The `openzeppelin.storage.ERC20Capped._cap` slot is written at init by
  `__ERC20Capped_init(INITIAL_SUPPLY)` but **never read** because `cap()` is a `pure`
  override returning `INITIAL_SUPPLY` directly. A future implementation that drops the
  `pure` override will resume reading the slot, which still contains `INITIAL_SUPPLY`
  (no migration needed for that path). See `docs/UPGRADE-HAZARDS.md` H-1.

- `__gap` arrays are not used. OZ v5 + ERC-7201 supersedes that pattern.

- Adding any new namespaced struct in a future implementation requires computing a fresh
  slot and asserting it does not collide with any slot above. See `docs/UPGRADE-HAZARDS.md`
  H-4.
