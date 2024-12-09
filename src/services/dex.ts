import { ethers } from "ethers";
import { Token, PriceQuote, DEXProtocol, SUPPORTED_DEXES } from "../types/dex";
import { logError, logInfo } from "../utils/logger";
import { UniswapV2Handler } from "./handlers/UniswapV2Handler";
import { UniswapV3Handler } from "./handlers/UniswapV3Handler";

// Router ABI for trading functions
const ROUTER_ABI = [
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
];

export class DexService {
  private provider: ethers.Provider;
  private signer?: ethers.Signer;
  private handlers: Map<string, UniswapV2Handler | UniswapV3Handler>;

  constructor(provider: ethers.Provider, privateKey?: string) {
    this.provider = provider;
    if (privateKey) {
      this.signer = new ethers.Wallet(privateKey, provider);
    }

    // Initialize handlers
    this.handlers = new Map();
    for (const dex of SUPPORTED_DEXES) {
      if (dex.version === "v2") {
        this.handlers.set(dex.name, new UniswapV2Handler(provider, dex));
      } else if (dex.version === "v3") {
        this.handlers.set(dex.name, new UniswapV3Handler(provider, dex));
      }
    }
  }

  async findArbitrage(
    tokenA: Token,
    tokenB: Token,
    amount: bigint
  ): Promise<{
    route: PriceQuote[];
    profit: bigint;
    profitPercentage: number;
    requiredCapital: bigint;
    estimatedGasCost: bigint;
  } | null> {
    try {
      const quotes: PriceQuote[] = [];

      // Get quotes from all handlers
      for (const handler of this.handlers.values()) {
        const dexQuotes = await handler.getQuotes(tokenA, tokenB, amount);
        quotes.push(...dexQuotes);
      }

      if (quotes.length === 0) {
        logInfo(`No valid quotes found for ${tokenA.symbol}/${tokenB.symbol}`);
        return null;
      }

      // Find best arbitrage opportunity
      let bestProfit = 0n;
      let bestRoute: PriceQuote[] = [];

      for (const quoteA of quotes) {
        for (const quoteB of quotes) {
          if (quoteA.dexName === quoteB.dexName) continue;

          const profit = quoteB.outputAmount - quoteA.inputAmount;
          if (profit > bestProfit) {
            bestProfit = profit;
            bestRoute = [quoteA, quoteB];
          }
        }
      }

      if (bestProfit > 0n && bestRoute.length === 2) {
        const profitPercentage =
          Number((bestProfit * 10000n) / bestRoute[0].inputAmount) / 100;

        if (profitPercentage > 500) {
          logInfo(
            `Unrealistic profit percentage for ${tokenA.symbol}/${tokenB.symbol}: ${profitPercentage}%`
          );
          return null;
        }

        return {
          route: bestRoute,
          profit: bestProfit,
          profitPercentage,
          requiredCapital: bestRoute[0].inputAmount,
          estimatedGasCost:
            bestRoute[0].estimatedGas + bestRoute[1].estimatedGas,
        };
      }

      return null;
    } catch (error) {
      logError(
        `Error finding arbitrage for ${tokenA.symbol}/${tokenB.symbol}`,
        error
      );
      throw error;
    }
  }

  async executeArbitrage(
    tokenA: Token,
    tokenB: Token,
    amount: bigint,
    route: PriceQuote[]
  ): Promise<string> {
    if (!this.signer) {
      throw new Error("No signer available for executing trades");
    }

    // Implementation of trade execution...
    // This would need to be updated to handle both V2 and V3 trades
    throw new Error("Trade execution not implemented yet");
  }
}
