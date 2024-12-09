import { ethers } from "ethers";
import dotenv from "dotenv";
import { DexService } from "./services/dex";
import { CEXService } from "./services/cex";
import { Token } from "./types/dex";
import { logArb, logError, logInfo, logDebug } from "./utils/logger";

dotenv.config();

// Common tokens to monitor
const TOKENS: { [key: string]: Token } = {
  // Major tokens
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
  // DeFi tokens
  UNI: {
    address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    symbol: "UNI",
    decimals: 18,
  },
  LINK: {
    address: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
    symbol: "LINK",
    decimals: 18,
  },
  AAVE: {
    address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
    symbol: "AAVE",
    decimals: 18,
  },
  CRV: {
    address: "0xD533a949740bb3306d119CC777fa900bA034cd52",
    symbol: "CRV",
    decimals: 18,
  },
  // Liquid staking tokens
  STETH: {
    address: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
    symbol: "stETH",
    decimals: 18,
  },
  RETH: {
    address: "0xae78736Cd615f374D3085123A210448E74Fc6393",
    symbol: "rETH",
    decimals: 18,
  },
  // Stablecoins
  FRAX: {
    address: "0x853d955aCEf822Db058eb8505911ED77F175b99e",
    symbol: "FRAX",
    decimals: 18,
  },
  LUSD: {
    address: "0x5f98805A4E8be255a32880FDeC7F6728C6568bA0",
    symbol: "LUSD",
    decimals: 18,
  },
};

function getEtherscanLink(address: string): string {
  return `https://etherscan.io/token/${address}`;
}

class ArbitrageBot {
  private dexService: DexService;
  private cexService: CEXService;
  private provider: ethers.JsonRpcProvider;

  constructor() {
    if (!process.env.RPC_URL || !process.env.PRIVATE_KEY) {
      throw new Error(
        "Missing RPC_URL or PRIVATE_KEY in environment variables"
      );
    }

    this.provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    this.dexService = new DexService(this.provider, process.env.PRIVATE_KEY);
    this.cexService = new CEXService();
  }

  async monitorPrices() {
    logInfo("Monitoring prices across DEXes and CEXes...");

    // Monitor major pairs
    const pairs = [
      // Stablecoin pairs
      [TOKENS.USDC, TOKENS.USDT],
      [TOKENS.USDC, TOKENS.DAI],
      [TOKENS.USDT, TOKENS.DAI],
      [TOKENS.USDC, TOKENS.FRAX],
      [TOKENS.USDC, TOKENS.LUSD],

      // ETH pairs
      [TOKENS.WETH, TOKENS.USDC],
      [TOKENS.WETH, TOKENS.USDT],
      [TOKENS.WETH, TOKENS.DAI],
      [TOKENS.WETH, TOKENS.STETH],
      [TOKENS.WETH, TOKENS.RETH],

      // DeFi blue chips
      [TOKENS.WETH, TOKENS.UNI],
      [TOKENS.WETH, TOKENS.LINK],
      [TOKENS.WETH, TOKENS.AAVE],
      [TOKENS.WETH, TOKENS.CRV],

      // Stablecoin/DeFi pairs
      [TOKENS.USDC, TOKENS.UNI],
      [TOKENS.USDC, TOKENS.LINK],
      [TOKENS.USDC, TOKENS.AAVE],
      [TOKENS.USDC, TOKENS.CRV],
    ];

    for (const [tokenA, tokenB] of pairs) {
      try {
        // Get DEX prices
        const dexArbitrage = await this.dexService.findArbitrage(
          tokenA,
          tokenB,
          this.getBaseAmount(tokenA)
        );

        // Get CEX prices if it's a major pair
        if (this.isMajorPair(tokenA, tokenB)) {
          const symbol = this.getCEXSymbol(tokenA, tokenB);
          if (symbol) {
            const cexPrices = await this.cexService.getAllPrices(symbol);

            if (dexArbitrage) {
              const dexPrice = Number(
                ethers.formatUnits(
                  dexArbitrage.route[0].outputAmount,
                  tokenB.decimals
                )
              );

              const cexArbitrage = this.cexService.findArbitrage(
                dexPrice,
                cexPrices
              );

              if (cexArbitrage) {
                logArb(
                  `Found CEX arbitrage opportunity for ${tokenA.symbol}/${tokenB.symbol}:`
                );
                logArb(`${cexArbitrage.direction}`);
                logArb(`Profit: ${cexArbitrage.profitPercent.toFixed(2)}%`);
                logArb(`CEX: ${cexArbitrage.cex}`);
              }
            }
          }
        }

        // Original DEX arbitrage logic
        if (dexArbitrage) {
          logArb(
            `Found DEX arbitrage opportunity for ${tokenA.symbol}/${tokenB.symbol}:`
          );
          logArb(
            `Required capital: ${ethers.formatUnits(
              dexArbitrage.requiredCapital,
              tokenA.decimals
            )} ${tokenA.symbol}`
          );
          logArb(
            `Expected profit: ${ethers.formatUnits(
              dexArbitrage.profit,
              tokenB.decimals
            )} ${tokenB.symbol}`
          );
          logArb(
            `Profit percentage: ${dexArbitrage.profitPercentage.toFixed(2)}%`
          );
          logArb(
            `Estimated gas cost: ${ethers.formatEther(
              dexArbitrage.estimatedGasCost
            )} ETH`
          );
          logArb(
            `Route: ${dexArbitrage.route.map((q) => q.dexName).join(" -> ")}`
          );

          if (dexArbitrage.profitPercentage > 0.5) {
            await this.executeArbitrage(
              tokenA,
              tokenB,
              this.getBaseAmount(tokenA),
              dexArbitrage.route
            );
          } else {
            logInfo("Skipping execution - profit too small");
          }
        }
      } catch (error) {
        logError(`Error monitoring ${tokenA.symbol}/${tokenB.symbol}`, error);
      }
    }
  }

  private getBaseAmount(token: Token): bigint {
    if (token.symbol === "WETH") {
      return ethers.parseEther("1"); // 1 ETH
    } else if (token.symbol.includes("ETH")) {
      return ethers.parseEther("1"); // 1 LST
    } else if (token.decimals === 6) {
      return ethers.parseUnits("1000", 6); // 1000 USDC/USDT
    } else {
      return ethers.parseUnits("1000", 18); // 1000 DAI/other
    }
  }

  private isMajorPair(tokenA: Token, tokenB: Token): boolean {
    // Check if both tokens are in our symbol map
    return this.getCEXSymbol(tokenA, tokenB) !== null;
  }

  private getCEXSymbol(tokenA: Token, tokenB: Token): string | null {
    // Convert our tokens to Binance symbols
    const symbolMap: { [key: string]: string } = {
      WETH: "ETH",
      USDC: "USDC",
      USDT: "USDT",
      DAI: "DAI",
      UNI: "UNI",
      LINK: "LINK",
      AAVE: "AAVE",
      CRV: "CRV",
      STETH: "STETH",
      RETH: "RETH",
      FRAX: "FRAX",
      LUSD: "LUSD",
    };

    const baseSymbol = symbolMap[tokenA.symbol];
    const quoteSymbol = symbolMap[tokenB.symbol];

    // Only return if both symbols are mapped
    if (!baseSymbol || !quoteSymbol) {
      return null;
    }

    // Common Binance pairs
    const validPairs = [
      "ETHUSDT",
      "ETHUSDC",
      "ETHDAI",
      "UNIUSDT",
      "UNIUSDC",
      "LINKUSDT",
      "LINKUSDC",
      "AAVEUSDT",
      "AAVEUSDC",
      "CRVUSDT",
      "CRVUSDC",
      "USDCUSDT",
    ];

    const pair = `${baseSymbol}${quoteSymbol}`;
    return validPairs.includes(pair) ? pair : null;
  }

  private async executeArbitrage(
    tokenA: Token,
    tokenB: Token,
    amount: bigint,
    route: any[]
  ) {
    try {
      logInfo("\nExecuting arbitrage trade...");
      const txHash = await this.dexService.executeArbitrage(
        tokenA,
        tokenB,
        amount,
        route
      );
      logInfo(`Arbitrage executed! Transaction: ${txHash}`);
    } catch (error) {
      logError("Error executing arbitrage:", error);
    }
  }
}

async function main() {
  logInfo("\n🥪 Starting arby's arbitrage bot...\n");

  // Print monitored tokens
  logInfo("Monitored tokens:");
  Object.entries(TOKENS).forEach(([symbol, token]) => {
    logInfo(`${symbol}: ${token.address}`);
    logDebug(`Etherscan: ${getEtherscanLink(token.address)}`);
    logDebug(`Decimals: ${token.decimals}\n`);
  });

  // Print monitored pairs
  logInfo("Monitoring pairs:");
  logInfo("- WETH/USDC");
  logInfo("- WETH/USDT");
  logInfo("- WETH/DAI");
  logInfo("- USDC/USDT\n");

  const bot = new ArbitrageBot();

  try {
    while (true) {
      await bot.monitorPrices();
      // Wait 1 block before checking again (about 12 seconds on Ethereum)
      await new Promise((resolve) => setTimeout(resolve, 12000));
    }
  } catch (error) {
    logError("Error in main loop", error);
  }
}

main();
