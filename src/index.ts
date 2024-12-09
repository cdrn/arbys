import { ethers } from "ethers";
import dotenv from "dotenv";
import { DexService } from "./services/dex";
import { Token } from "./types/dex";

dotenv.config();

// Common tokens to monitor
const TOKENS: { [key: string]: Token } = {
  WETH: {
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    symbol: "WETH",
    decimals: 18,
  },
  USDC: {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    symbol: "USDC",
    decimals: 6,
  },
  USDT: {
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    symbol: "USDT",
    decimals: 6,
  },
  DAI: {
    address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    symbol: "DAI",
    decimals: 18,
  },
};

function getEtherscanLink(address: string): string {
  return `https://etherscan.io/token/${address}`;
}

class ArbitrageBot {
  private dexService: DexService;
  private provider: ethers.JsonRpcProvider;

  constructor() {
    if (!process.env.RPC_URL || !process.env.PRIVATE_KEY) {
      throw new Error(
        "Missing RPC_URL or PRIVATE_KEY in environment variables"
      );
    }

    this.provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    this.dexService = new DexService(this.provider, process.env.PRIVATE_KEY);
  }

  async monitorPrices() {
    console.log("\nMonitoring prices across DEXes...");

    // Monitor major pairs
    const pairs = [
      [TOKENS.WETH, TOKENS.USDC],
      [TOKENS.WETH, TOKENS.USDT],
      [TOKENS.WETH, TOKENS.DAI],
      [TOKENS.USDC, TOKENS.USDT],
    ];

    for (const [tokenA, tokenB] of pairs) {
      try {
        // Use 1 ETH as base amount for WETH pairs, or 1000 USDC for stablecoin pairs
        const baseAmount =
          tokenA.symbol === "WETH"
            ? ethers.parseEther("1")
            : ethers.parseUnits("1000", tokenA.decimals);

        const arbitrage = await this.dexService.findArbitrage(
          tokenA,
          tokenB,
          baseAmount
        );

        if (arbitrage) {
          console.log(
            `\nFound arbitrage opportunity for ${tokenA.symbol}/${tokenB.symbol}:`
          );
          console.log(
            `Required capital: ${ethers.formatUnits(
              arbitrage.requiredCapital,
              tokenA.decimals
            )} ${tokenA.symbol}`
          );
          console.log(
            `Expected profit: ${ethers.formatUnits(
              arbitrage.profit,
              tokenB.decimals
            )} ${tokenB.symbol}`
          );
          console.log(
            `Profit percentage: ${arbitrage.profitPercentage.toFixed(2)}%`
          );
          console.log(
            `Estimated gas cost: ${ethers.formatEther(
              arbitrage.estimatedGasCost
            )} ETH`
          );
          console.log(
            `Route: ${arbitrage.route.map((q) => q.dexName).join(" -> ")}`
          );

          // Only execute if profit is significant (e.g., > 0.5%)
          if (arbitrage.profitPercentage > 0.5) {
            await this.executeArbitrage(
              tokenA,
              tokenB,
              baseAmount,
              arbitrage.route
            );
          } else {
            console.log("Skipping execution - profit too small");
          }
        }
      } catch (error) {
        console.error(
          `Error monitoring ${tokenA.symbol}/${tokenB.symbol}:`,
          error
        );
      }
    }
  }

  private async executeArbitrage(
    tokenA: Token,
    tokenB: Token,
    amount: bigint,
    route: any[]
  ) {
    try {
      console.log("\nExecuting arbitrage trade...");
      const txHash = await this.dexService.executeArbitrage(
        tokenA,
        tokenB,
        amount,
        route
      );
      console.log(`Arbitrage executed! Transaction: ${txHash}`);
    } catch (error) {
      console.error("Error executing arbitrage:", error);
    }
  }
}

async function main() {
  console.log("\n🥪 Starting arby's arbitrage bot...\n");

  // Print monitored tokens
  console.log("Monitored tokens:");
  Object.entries(TOKENS).forEach(([symbol, token]) => {
    console.log(`${symbol}: ${token.address}`);
    console.log(`Etherscan: ${getEtherscanLink(token.address)}`);
    console.log(`Decimals: ${token.decimals}\n`);
  });

  // Print monitored pairs
  console.log("Monitoring pairs:");
  console.log("- WETH/USDC");
  console.log("- WETH/USDT");
  console.log("- WETH/DAI");
  console.log("- USDC/USDT\n");

  const bot = new ArbitrageBot();

  try {
    while (true) {
      await bot.monitorPrices();
      // Wait 1 block before checking again (about 12 seconds on Ethereum)
      await new Promise((resolve) => setTimeout(resolve, 12000));
    }
  } catch (error) {
    console.error("Error in main loop:", error);
  }
}

main();
