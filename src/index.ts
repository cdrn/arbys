import { ethers } from "ethers";
import dotenv from "dotenv";
import Redis from "ioredis";
import { DexService } from "./services/dex";
import { CEXService } from "./services/cex";
import { PriceService } from "./services/price";
import { ArbitrageService } from "./services/arbitrage";
import { Token } from "./types/dex";
import { logError, logInfo } from "./utils/logger";

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

class ArbitrageBot {
  private priceService: PriceService;
  private arbitrageService: ArbitrageService;
  private redis: Redis;

  constructor() {
    if (!process.env.RPC_URL || !process.env.PRIVATE_KEY) {
      throw new Error(
        "Missing RPC_URL or PRIVATE_KEY in environment variables"
      );
    }

    // Initialize Redis
    this.redis = new Redis({
      host: process.env.REDIS_HOST || "localhost",
      port: Number(process.env.REDIS_PORT) || 6379,
    });

    // Initialize provider and services
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const dexService = new DexService(provider, process.env.PRIVATE_KEY);
    const cexService = new CEXService();

    // Define major pairs to monitor
    const majorPairs: [Token, Token][] = [
      [TOKENS.USDC, TOKENS.USDT],
      [TOKENS.USDC, TOKENS.DAI],
      [TOKENS.WETH, TOKENS.USDC],
      [TOKENS.WETH, TOKENS.USDT],
      [TOKENS.WETH, TOKENS.DAI],
    ];

    // Initialize price and arbitrage services
    this.priceService = new PriceService(
      this.redis,
      dexService.getHandlers(),
      cexService,
      majorPairs
    );

    this.arbitrageService = new ArbitrageService(
      this.redis,
      majorPairs,
      Number(process.env.MIN_PROFIT_PERCENT) || 0.5,
      2000 // 2 second max price age
    );
  }

  async start() {
    logInfo("\n🥪 Starting arby's arbitrage bot...\n");

    try {
      // Start both services concurrently
      await Promise.all([
        this.priceService.startPriceUpdates(),
        this.arbitrageService.startArbitrageScanning(),
      ]);
    } catch (error) {
      logError("Fatal error in main loop", error);
      process.exit(1);
    }
  }

  async cleanup() {
    await this.redis.quit();
  }
}

// Handle cleanup on exit
const bot = new ArbitrageBot();
process.on("SIGINT", async () => {
  logInfo("\nShutting down...");
  await bot.cleanup();
  process.exit();
});

bot.start().catch((error) => {
  logError("Failed to start bot", error);
  process.exit(1);
});
