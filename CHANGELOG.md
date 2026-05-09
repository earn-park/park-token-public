# Changelog

## v1.0.0 — 2026-05-09 (audit-handoff snapshot)

Initial public release of the PARK Token smart-contract source for
external audit.

### Live deployments
- Proxy address (BSC + Arbitrum, same address via ZeframLou CREATE3):
  `0xA4a83c12bFed8Ba35da4a6203f6F5E783a887BCC`
- BSC chainId 56, Arbitrum chainId 42161
- BOOTSTRAP-config: Safe 1/1, Timelock minDelay 900 s
- Production uplift to 3/5 + 21600 s minDelay is the HARD GATE before
  any public TGE / CEX listing / distribution.

### Surface
- ERC-20 (decimals 6, fixed cap 1B PARK) with ERC-2612 permit.
- UUPS upgradeable via OpenZeppelin v5.6.1 Upgradeable contracts.
- AccessControl roles: `DEFAULT_ADMIN_ROLE`, `UPGRADER_ROLE`,
  `RESCUER_ROLE`, `TIMELOCK_ADMIN_ROLE`.
- `rescueERC20`, `rescueETH` for stuck-token recovery (RESCUER role).
- ERC-7201 namespaced storage at slot
  `0x2c6f79634877d4fe165c547185a8e0ef04f5e43f93083c43ee2d9f6afee57d00`.

### Toolchain pin
- Solidity 0.8.34, viaIR=true, optimizer_runs=10000, evm cancun.
- Foundry 1.5.1-stable @ `b0a9dd9c`.
- OpenZeppelin Contracts 5.6.1, OZ Upgradeable 5.6.1, forge-std 1.15.0.
- Node 22.20.0, TypeScript 6.0.3, viem 2.48.4, Hardhat 3.4.1.

See `docs/AUDIT-SCOPE.md` and `docs/BYTECODE-BASELINE.md` for full
reproducibility instructions.
