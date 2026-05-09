import "dotenv/config";

// hardhatEthers is registered solely so deploy-base-upgrade-impl.ts can use
// hre.network.connect().ethers for factory deploy. All other scripts use viem.
import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatFoundry from "@nomicfoundation/hardhat-foundry";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [
    hardhatFoundry,
    hardhatViem,
    hardhatVerify,
    hardhatEthers
  ],
  solidity: {
    version: "0.8.34",
    settings: {
      evmVersion: "cancun",
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 10000
      }
    }
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache_hardhat",
    artifacts: "./artifacts"
  },
  networks: {
    bsc: {
      type: "http",
      chainType: "generic",
      url: configVariable("BSC_RPC_URL"),
      chainId: 56,
      accounts: [configVariable("BSC_PRIVATE_KEY")]
    }
  },
  verify: {
    etherscan: {
      apiKey: configVariable("MULTI_EXPLORER_API_KEY")
    }
  }
});
