// One-shot helper: deploy a new ParkToken implementation only
// (no proxy step — proxy will adopt this impl via Timelock-gated upgrade).
//
// Usage: npx hardhat run scripts/ops/deploy-base-upgrade-impl.ts --network bsc
//
// Uses ethers via Hardhat runtime for the factory deploy. The proxy-side
// upgrade flow goes through the Timelock — see scripts/ops/schedule-upgrade.ts.
//
import "dotenv/config";
import hre from "hardhat";

async function main(): Promise<void> {
  const connection = await hre.network.connect();
  const {ethers} = connection;

  const signers = await ethers.getSigners();
  const deployer = signers[0];
  if (!deployer) throw new Error("No signer configured");

  const net = await ethers.provider.getNetwork();
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Network:  ${connection.networkName} (chainId=${Number(net.chainId)})`);

  const Factory = await ethers.getContractFactory("ParkToken");
  const impl = await Factory.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`\nNew implementation: ${implAddr}`);

  console.log(`\nNext: schedule the upgrade via Timelock through Safe.`);
  console.log(`See docs/DEPLOY-MECHANIC.md for the upgrade flow.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
