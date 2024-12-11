import Redis from "ioredis";
import { ethers } from "ethers";
import { Token } from "../types/dex";
import { BaseDexHandler } from "./handlers/BaseDexHandler";
import { CEXService } from "./cex";
import {
  logPrice,
  logPriceError,
  logPriceInfo,
  logPriceDebug,
} from "../utils/logger";

export interface PoolPrice {
  dexName: string;
  price: number;
  timestamp: number;
  liquidity?: bigint;
}

export class PriceService {
  private redis: Redis;
  private dexHandlers: Map<string, BaseDexHandler>;
  private cexService: CEXService;
  private pairs: [Token, Token][];
  private isRunning: boolean = false;

  constructor(
    redis: Redis,
    dexHandlers: Map<string, BaseDexHandler>,
    cexService: CEXService,
    pairs: [Token, Token][]
  ) {
    this.redis = redis;
    this.dexHandlers = dexHandlers;
    this.cexService = cexService;
    this.pairs = pairs;
  }

  private getRedisKey(tokenA: Token, tokenB: Token): string {
    return `price:${tokenA.symbol}-${tokenB.symbol}`;
  }

  async startPriceUpdates(interval: number = 1000): Promise<void> {
    if (this.isRunning) {
      logPriceWarn("Price updates already running");
      return;
    }

    this.isRunning = true;
    logPriceInfo("Starting price update service");

    while (this.isRunning) {
      try {
        await this.updateAllPrices();
        await new Promise((resolve) => setTimeout(resolve, interval));
      } catch (error) {
        logPriceError("Error in price update loop", error);
        await new Promise((resolve) => setTimeout(resolve, interval * 2));
      }
    }
  }

  private async updateAllPrices(): Promise<void> {
    for (const [tokenA, tokenB] of this.pairs) {
      try {
        const prices: PoolPrice[] = [];

        // Get DEX prices
        for (const [dexName, handler] of this.dexHandlers) {
          try {
            const quotes = await handler.getQuotes(
              tokenA,
              tokenB,
              ethers.parseUnits("1", tokenA.decimals)
            );

            for (const quote of quotes) {
              const price =
                Number(quote.outputAmount) / Number(quote.inputAmount);
              logPriceDebug(
                `${tokenA.symbol}->${
                  tokenB.symbol
                } on ${dexName}: ${price.toFixed(6)}`
              );
              prices.push({
                dexName,
                price,
                timestamp: Date.now(),
                liquidity: quote.liquidity,
              });
            }
          } catch (error) {
            logPriceError(`Error getting ${dexName} prices`, error);
          }
        }

        // Store prices in Redis
        if (prices.length > 0) {
          const key = this.getRedisKey(tokenA, tokenB);
          await this.redis.set(key, JSON.stringify(prices), "EX", 5); // 5 second expiry
          logPrice(
            `Updated ${prices.length} prices for ${tokenA.symbol}/${tokenB.symbol}`
          );
        }
      } catch (error) {
        logPriceError(
          `Error updating prices for ${tokenA.symbol}/${tokenB.symbol}`,
          error
        );
      }
    }
  }

  stop(): void {
    this.isRunning = false;
    logPriceInfo("Stopping price update service");
  }
}
