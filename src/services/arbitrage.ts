import Redis from "ioredis";
import { Token } from "../types/dex";
import { PoolPrice } from "./price";
import { ArbitrageOpportunity } from "../types/trade";
import { TradeExecutor } from "./trade";
import {
  logArb,
  logArbError,
  logArbInfo,
  logArbDebug,
  logArbWarn,
} from "../utils/logger";

export class ArbitrageService {
  private redis: Redis;
  private pairs: [Token, Token][];
  private minProfitPercent: number;
  private maxPriceAgeMs: number;
  private isRunning: boolean = false;
  private tradeExecutor?: TradeExecutor;

  constructor(
    redis: Redis,
    pairs: [Token, Token][],
    minProfitPercent: number,
    maxPriceAgeMs: number,
    tradeExecutor?: TradeExecutor
  ) {
    this.redis = redis;
    this.pairs = pairs;
    this.minProfitPercent = minProfitPercent;
    this.maxPriceAgeMs = maxPriceAgeMs;
    this.tradeExecutor = tradeExecutor;
  }

  private getRedisKey(tokenA: Token, tokenB: Token): string {
    return `price:${tokenA.symbol}-${tokenB.symbol}`;
  }

  async startArbitrageScanning(interval: number = 500): Promise<void> {
    if (this.isRunning) {
      logArbWarn("Arbitrage scanning already running");
      return;
    }

    this.isRunning = true;
    logArbInfo("Starting arbitrage scanning service");

    while (this.isRunning) {
      try {
        await this.scanForArbitrage();
        await new Promise((resolve) => setTimeout(resolve, interval));
      } catch (error) {
        logArbError("Error in arbitrage scanning loop", error);
        await new Promise((resolve) => setTimeout(resolve, interval * 2));
      }
    }
  }

  private async scanForArbitrage(): Promise<void> {
    for (const [tokenA, tokenB] of this.pairs) {
      try {
        const key = this.getRedisKey(tokenA, tokenB);
        const pricesJson = await this.redis.get(key);

        if (!pricesJson) {
          logArbDebug(`No prices found for ${tokenA.symbol}/${tokenB.symbol}`);
          continue;
        }

        const prices: PoolPrice[] = JSON.parse(pricesJson);
        const now = Date.now();

        // Filter out old prices
        const validPrices = prices.filter(
          (p) => now - p.timestamp <= this.maxPriceAgeMs
        );

        if (validPrices.length < 2) {
          logArbDebug(
            `Not enough valid prices for ${tokenA.symbol}/${tokenB.symbol}`
          );
          continue;
        }

        // Find arbitrage opportunities
        for (let i = 0; i < validPrices.length; i++) {
          for (let j = i + 1; j < validPrices.length; j++) {
            const priceA = validPrices[i];
            const priceB = validPrices[j];

            // Calculate profit percentages both ways
            const profitAtoB =
              ((priceB.price - priceA.price) / priceA.price) * 100;
            const profitBtoA =
              ((priceA.price - priceB.price) / priceB.price) * 100;

            // Calculate actual profit amounts (assuming 1 unit of tokenA)
            const baseAmount = 1; // 1 unit of tokenA
            const profitAmountAtoB = baseAmount * (priceB.price - priceA.price);
            const profitAmountBtoA = baseAmount * (priceA.price - priceB.price);

            if (profitAtoB > this.minProfitPercent) {
              const opportunity: ArbitrageOpportunity = {
                tokenA,
                tokenB,
                buyQuote: priceA,
                sellQuote: priceB,
                profitPercent: profitAtoB,
                profitAmount: profitAmountAtoB,
                timestamp: now,
              };

              logArb(
                `${tokenA.symbol}/${tokenB.symbol} Arbitrage:\n` +
                  `  Buy ${baseAmount} ${tokenA.symbol} on ${
                    priceA.dexName
                  } @ ${priceA.price.toFixed(6)}\n` +
                  `    Pool: ${priceA.poolAddress}\n` +
                  `  Sell on ${priceB.dexName} @ ${priceB.price.toFixed(6)}\n` +
                  `    Pool: ${priceB.poolAddress}\n` +
                  `  Profit: ${profitAtoB.toFixed(
                    2
                  )}% (${profitAmountAtoB.toFixed(6)} ${tokenB.symbol})`
              );

              if (this.tradeExecutor) {
                const validation = await this.tradeExecutor.validateArbitrage(
                  opportunity
                );
                if (validation.isValid) {
                  logArb(
                    `Executing trade with estimated net profit: ${validation.estimatedNetProfit}`
                  );
                  const result = await this.tradeExecutor.executeTrade(
                    opportunity
                  );
                  if (result.success) {
                    logArb(
                      `Trade executed successfully!\n` +
                        `  Transaction: ${result.transactionHash}\n` +
                        `  Gas Used: ${result.gasUsed}\n` +
                        `  Gas Cost: ${result.totalCost}\n` +
                        `  Actual Profit: ${result.actualProfit}`
                    );
                  } else {
                    logArbError(`Trade execution failed: ${result.error}`);
                  }
                } else {
                  logArbDebug(`Trade validation failed: ${validation.reason}`);
                }
              }
            } else if (profitBtoA > this.minProfitPercent) {
              const opportunity: ArbitrageOpportunity = {
                tokenA,
                tokenB,
                buyQuote: priceB,
                sellQuote: priceA,
                profitPercent: profitBtoA,
                profitAmount: profitAmountBtoA,
                timestamp: now,
              };

              logArb(
                `${tokenA.symbol}/${tokenB.symbol} Arbitrage:\n` +
                  `  Buy ${baseAmount} ${tokenA.symbol} on ${
                    priceB.dexName
                  } @ ${priceB.price.toFixed(6)}\n` +
                  `    Pool: ${priceB.poolAddress}\n` +
                  `  Sell on ${priceA.dexName} @ ${priceA.price.toFixed(6)}\n` +
                  `    Pool: ${priceA.poolAddress}\n` +
                  `  Profit: ${profitBtoA.toFixed(
                    2
                  )}% (${profitAmountBtoA.toFixed(6)} ${tokenB.symbol})`
              );

              if (this.tradeExecutor) {
                const validation = await this.tradeExecutor.validateArbitrage(
                  opportunity
                );
                if (validation.isValid) {
                  logArb(
                    `Executing trade with estimated net profit: ${validation.estimatedNetProfit}`
                  );
                  const result = await this.tradeExecutor.executeTrade(
                    opportunity
                  );
                  if (result.success) {
                    logArb(
                      `Trade executed successfully!\n` +
                        `  Transaction: ${result.transactionHash}\n` +
                        `  Gas Used: ${result.gasUsed}\n` +
                        `  Gas Cost: ${result.totalCost}\n` +
                        `  Actual Profit: ${result.actualProfit}`
                    );
                  } else {
                    logArbError(`Trade execution failed: ${result.error}`);
                  }
                } else {
                  logArbDebug(`Trade validation failed: ${validation.reason}`);
                }
              }
            }
          }
        }
      } catch (error) {
        logArbError(
          `Error scanning arbitrage for ${tokenA.symbol}/${tokenB.symbol}`,
          error
        );
      }
    }
  }

  stop(): void {
    this.isRunning = false;
    logArbInfo("Stopping arbitrage scanning service");
  }
}
