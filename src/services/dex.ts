import { ethers } from "ethers";
import { Token, PriceQuote, SUPPORTED_DEXES } from "../types/dex";

// Uniswap V2 Router and Pair ABI
const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
];

const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) external view returns (address pair)",
];

const PAIR_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
];

const MAX_PROFIT_THRESHOLD = 30; // 30% max profit threshold
const MIN_LIQUIDITY_USD = 50000n; // $50k minimum liquidity
const MAX_PRICE_IMPACT = 3; // 3% max price impact
const MIN_PROFIT_USD = 50n; // Minimum $50 profit to execute
const CHUNK_SPLITS = 4; // Number of chunks to split large trades into

export interface ArbitrageOpportunity {
  profit: bigint;
  route: PriceQuote[];
  requiredCapital: bigint;
  profitPercentage: number;
  estimatedGasCost: bigint;
  priceImpact: number;
}

interface PoolInfo {
  reserve0: bigint;
  reserve1: bigint;
  token0: string;
  token1: string;
  pairAddress: string;
}

interface OptimalTrade {
  size: bigint;
  expectedProfit: bigint;
  priceImpact: number;
}

// Cache pool info for 1 block
interface PoolCache {
  info: PoolInfo;
  timestamp: number;
  blockNumber: number;
}

export class DexService {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private poolCache: Map<string, PoolCache> = new Map();

  constructor(provider: ethers.JsonRpcProvider, privateKey: string) {
    this.provider = provider;
    this.wallet = new ethers.Wallet(privateKey, provider);
  }

  private getCacheKey(
    dex: (typeof SUPPORTED_DEXES)[0],
    tokenA: Token,
    tokenB: Token
  ): string {
    return `${dex.name}-${tokenA.address}-${tokenB.address}`;
  }

  private async getPoolInfoCached(
    dex: (typeof SUPPORTED_DEXES)[0],
    tokenA: Token,
    tokenB: Token
  ): Promise<PoolInfo | null> {
    const cacheKey = this.getCacheKey(dex, tokenA, tokenB);
    const currentBlock = await this.provider.getBlockNumber();
    const cached = this.poolCache.get(cacheKey);

    if (cached && cached.blockNumber === currentBlock) {
      return cached.info;
    }

    const poolInfo = await this.getPoolInfo(dex, tokenA, tokenB);
    if (poolInfo) {
      this.poolCache.set(cacheKey, {
        info: poolInfo,
        timestamp: Date.now(),
        blockNumber: currentBlock,
      });
    }

    return poolInfo;
  }

  private formatReserve(amount: bigint, decimals: number): string {
    return Number(ethers.formatUnits(amount, decimals)).toLocaleString(
      undefined,
      {
        maximumFractionDigits: 4,
      }
    );
  }

  private async getPoolInfo(
    dex: (typeof SUPPORTED_DEXES)[0],
    tokenA: Token,
    tokenB: Token
  ): Promise<PoolInfo | null> {
    try {
      // First verify the factory contract exists
      const code = await this.provider.getCode(dex.factory);
      if (code === "0x") {
        console.log(`${dex.name} factory contract not found at ${dex.factory}`);
        return null;
      }

      const factory = new ethers.Contract(
        dex.factory,
        FACTORY_ABI,
        this.provider
      );

      let pairAddress: string;
      try {
        pairAddress = await factory.getPair(tokenA.address, tokenB.address);
      } catch (err) {
        const error = err as Error;
        console.log(
          `${dex.name} factory.getPair failed: ${
            error?.message || "Unknown error"
          }`
        );
        return null;
      }

      if (pairAddress === "0x0000000000000000000000000000000000000000") {
        console.log(`No ${tokenA.symbol}/${tokenB.symbol} pool on ${dex.name}`);
        return null;
      }

      // Verify the pair contract exists
      const pairCode = await this.provider.getCode(pairAddress);
      if (pairCode === "0x") {
        console.log(`${dex.name} pair contract not found at ${pairAddress}`);
        return null;
      }

      const pair = new ethers.Contract(pairAddress, PAIR_ABI, this.provider);

      let reserves: [bigint, bigint], token0: string, token1: string;
      try {
        [reserves, token0, token1] = await Promise.all([
          pair.getReserves(),
          pair.token0(),
          pair.token1(),
        ]);
      } catch (err) {
        const error = err as Error;
        console.log(
          `${dex.name} pair contract calls failed: ${
            error?.message || "Unknown error"
          }`
        );
        return null;
      }

      const [reserve0, reserve1] = reserves;

      // Log pool reserves
      const isToken0A = token0.toLowerCase() === tokenA.address.toLowerCase();
      const reserveA = isToken0A ? reserve0 : reserve1;
      const reserveB = isToken0A ? reserve1 : reserve0;

      if (reserveA === 0n || reserveB === 0n) {
        console.log(`${dex.name} pool has zero reserves`);
        return null;
      }

      console.log(`\n${dex.name} Pool (${pairAddress}):`);
      console.log(
        `${tokenA.symbol}: ${this.formatReserve(reserveA, tokenA.decimals)}`
      );
      console.log(
        `${tokenB.symbol}: ${this.formatReserve(reserveB, tokenB.decimals)}`
      );

      return {
        reserve0,
        reserve1,
        token0,
        token1,
        pairAddress,
      };
    } catch (err) {
      const error = err as { code?: string; message?: string };
      if (error?.code === "BAD_DATA") {
        console.log(`${dex.name} contract interface mismatch - skipping`);
      } else {
        console.error(
          `Error getting pool info for ${dex.name}:`,
          error?.message || "Unknown error"
        );
      }
      return null;
    }
  }

  private calculatePriceImpact(
    amountIn: bigint,
    reserveIn: bigint,
    reserveOut: bigint
  ): number {
    // Using constant product formula (x * y = k)
    const amountInWithFee = (amountIn * 997n) / 1000n; // 0.3% fee
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn + amountInWithFee;
    const amountOut = numerator / denominator;

    // Calculate price impact
    const spotPrice = reserveOut / reserveIn;
    const executionPrice = amountOut / amountIn;
    const priceImpact = Math.abs(
      (Number(spotPrice - executionPrice) / Number(spotPrice)) * 100
    );

    return priceImpact;
  }

  private hasEnoughLiquidity(
    poolInfo: PoolInfo,
    tokenA: Token,
    tokenB: Token,
    amount: bigint
  ): boolean {
    const isToken0A =
      poolInfo.token0.toLowerCase() === tokenA.address.toLowerCase();
    const reserveA = isToken0A ? poolInfo.reserve0 : poolInfo.reserve1;
    const reserveB = isToken0A ? poolInfo.reserve1 : poolInfo.reserve0;

    // Calculate rough USD value of reserves (assuming tokenB is a stablecoin)
    let reserveUsdValue: bigint;
    if (tokenB.symbol.includes("USD")) {
      reserveUsdValue = reserveB;
    } else if (tokenA.symbol === "WETH") {
      // If WETH is tokenA, use a rough ETH price estimate
      reserveUsdValue = (reserveA * 2000n) / 10n ** BigInt(tokenA.decimals);
    } else {
      // Default case
      reserveUsdValue = reserveB;
    }

    // Check minimum liquidity
    if (reserveUsdValue < MIN_LIQUIDITY_USD) {
      console.log(
        `Insufficient USD liquidity: $${this.formatReserve(
          reserveUsdValue,
          tokenB.decimals
        )}`
      );
      return false;
    }

    // Check if pool has enough of tokenA
    if (reserveA < amount * 3n) {
      console.log(
        `Insufficient ${tokenA.symbol} liquidity: ${this.formatReserve(
          reserveA,
          tokenA.decimals
        )} < ${this.formatReserve(amount * 3n, tokenA.decimals)}`
      );
      return false;
    }

    // Calculate price impact
    const priceImpact = this.calculatePriceImpact(amount, reserveA, reserveB);
    if (priceImpact > MAX_PRICE_IMPACT) {
      console.log(`Price impact too high: ${priceImpact.toFixed(2)}%`);
      return false;
    }

    return true;
  }

  private findOptimalTradeSize(
    poolInfo: PoolInfo,
    tokenA: Token,
    tokenB: Token,
    maxAmount: bigint
  ): OptimalTrade {
    const isToken0A =
      poolInfo.token0.toLowerCase() === tokenA.address.toLowerCase();
    const reserveIn = isToken0A ? poolInfo.reserve0 : poolInfo.reserve1;
    const reserveOut = isToken0A ? poolInfo.reserve1 : poolInfo.reserve0;

    // Try different trade sizes
    let bestTrade: OptimalTrade = {
      size: 0n,
      expectedProfit: 0n,
      priceImpact: 0,
    };

    // Start with 1/CHUNK_SPLITS of maxAmount and increase
    for (let i = 1; i <= CHUNK_SPLITS; i++) {
      const tradeSize = (maxAmount * BigInt(i)) / BigInt(CHUNK_SPLITS);
      const priceImpact = this.calculatePriceImpact(
        tradeSize,
        reserveIn,
        reserveOut
      );

      if (priceImpact <= MAX_PRICE_IMPACT) {
        const amountOut = this.getAmountOut(tradeSize, reserveIn, reserveOut);
        const profit = amountOut - tradeSize;

        // Convert profit to USD terms (rough estimation)
        const profitUsd = tokenB.symbol.includes("USD")
          ? profit
          : (profit * 2000n) / 10n ** BigInt(tokenB.decimals); // Using ETH = $2000 for estimation

        if (profitUsd > MIN_PROFIT_USD && profit > bestTrade.expectedProfit) {
          bestTrade = {
            size: tradeSize,
            expectedProfit: profit,
            priceImpact,
          };
        }
      }
    }

    return bestTrade;
  }

  private getAmountOut(
    amountIn: bigint,
    reserveIn: bigint,
    reserveOut: bigint
  ): bigint {
    const amountInWithFee = (amountIn * 997n) / 1000n;
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn + amountInWithFee;
    return numerator / denominator;
  }

  async getPriceQuotes(
    tokenIn: Token,
    tokenOut: Token,
    maxAmountIn: bigint
  ): Promise<PriceQuote[]> {
    // Parallelize pool info fetching
    const poolPromises = SUPPORTED_DEXES.map((dex) =>
      this.getPoolInfoCached(dex, tokenIn, tokenOut)
    );

    const poolInfos = await Promise.all(poolPromises);
    const validPools = poolInfos
      .map((pool, index) => ({
        pool,
        dex: SUPPORTED_DEXES[index],
      }))
      .filter((item) => item.pool !== null);

    // Parallelize optimal trade calculations
    const tradePromises = validPools.map(async ({ pool, dex }) => {
      try {
        const optimalTrade = this.findOptimalTradeSize(
          pool!,
          tokenIn,
          tokenOut,
          maxAmountIn
        );
        if (optimalTrade.size === 0n) {
          console.log(
            `No profitable trade size found for ${dex.name} within price impact limits`
          );
          return null;
        }

        const router = new ethers.Contract(
          dex.router,
          ROUTER_ABI,
          this.provider
        );

        // Parallelize amounts and gas estimation
        const [amounts, estimatedGas] = await Promise.all([
          router.getAmountsOut(optimalTrade.size, [
            tokenIn.address,
            tokenOut.address,
          ]),
          router.getAmountsOut.estimateGas(optimalTrade.size, [
            tokenIn.address,
            tokenOut.address,
          ]),
        ]);

        const outputAmount = amounts[1];
        const spotPrice = (outputAmount * 10000n) / optimalTrade.size;
        const profitPercentage = Number(spotPrice - 10000n) / 100;

        if (profitPercentage > MAX_PROFIT_THRESHOLD) {
          console.log(
            `Skipping suspicious price on ${
              dex.name
            }: ${profitPercentage.toFixed(2)}% profit seems too high`
          );
          return null;
        }

        console.log(
          `${dex.name} quote (${this.formatReserve(
            optimalTrade.size,
            tokenIn.decimals
          )} ${tokenIn.symbol}): ` +
            `${this.formatReserve(outputAmount, tokenOut.decimals)} ${
              tokenOut.symbol
            } ` +
            `(${profitPercentage.toFixed(
              2
            )}% profit, ${optimalTrade.priceImpact.toFixed(2)}% impact)`
        );

        return {
          dexName: dex.name,
          inputAmount: optimalTrade.size,
          outputAmount,
          path: [tokenIn.address, tokenOut.address],
          estimatedGas,
        };
      } catch (error) {
        console.error(`Error fetching quote from ${dex.name}:`, error);
        return null;
      }
    });

    const quotes = (await Promise.all(tradePromises)).filter(
      (quote): quote is PriceQuote => quote !== null
    );
    return quotes;
  }

  async findArbitrage(
    tokenA: Token,
    tokenB: Token,
    maxAmount: bigint
  ): Promise<ArbitrageOpportunity | null> {
    const startTime = Date.now();
    const quotes = await this.getPriceQuotes(tokenA, tokenB, maxAmount);

    if (quotes.length < 2) {
      return null;
    }

    // Sort quotes by output amount (descending)
    quotes.sort((a, b) => Number(b.outputAmount - a.outputAmount));

    const bestBuy = quotes[0];
    const bestSell = quotes[1];
    const profit = bestSell.outputAmount - bestBuy.inputAmount;

    // Calculate gas costs
    const totalGas = bestBuy.estimatedGas + bestSell.estimatedGas;
    const gasPrice = (await this.provider.getFeeData()).gasPrice || 0n;
    const gasCostInEth = totalGas * gasPrice;

    // Calculate profit percentage
    const profitPercentage =
      Number((profit * 10000n) / bestBuy.inputAmount) / 100;

    const endTime = Date.now();
    console.log(`Arbitrage check completed in ${endTime - startTime}ms`);

    // Convert gas cost to token terms (simplified)
    if (profit > gasCostInEth) {
      return {
        profit,
        route: [bestBuy, bestSell],
        requiredCapital: bestBuy.inputAmount,
        profitPercentage,
        estimatedGasCost: gasCostInEth,
        priceImpact: 0, // This will be calculated per-trade
      };
    }

    return null;
  }

  async executeArbitrage(
    tokenA: Token,
    tokenB: Token,
    amount: bigint,
    route: PriceQuote[]
  ): Promise<string> {
    const [buyQuote, sellQuote] = route;

    // Get router addresses
    const buyRouter = SUPPORTED_DEXES.find(
      (d) => d.name === buyQuote.dexName
    )!.router;
    const sellRouter = SUPPORTED_DEXES.find(
      (d) => d.name === sellQuote.dexName
    )!.router;

    // First approve tokens if needed
    const tokenContract = new ethers.Contract(
      tokenA.address,
      [
        "function approve(address spender, uint256 amount) external returns (bool)",
      ],
      this.wallet
    );

    // Approve both routers
    console.log(`Approving ${tokenA.symbol} for trading...`);
    await tokenContract.approve(buyRouter, amount);
    await tokenContract.approve(sellRouter, amount);

    // Execute buy on first DEX
    const buyRouterContract = new ethers.Contract(
      buyRouter,
      ROUTER_ABI,
      this.wallet
    );

    const minOutput = (buyQuote.outputAmount * 95n) / 100n; // 5% slippage
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60); // 1 minute

    console.log(`Executing buy on ${buyQuote.dexName}...`);
    const buyTx = await buyRouterContract.swapExactTokensForTokens(
      buyQuote.inputAmount,
      minOutput,
      buyQuote.path,
      this.wallet.address,
      deadline
    );

    await buyTx.wait();

    // Execute sell on second DEX
    const sellRouterContract = new ethers.Contract(
      sellRouter,
      ROUTER_ABI,
      this.wallet
    );

    const minSellOutput = (sellQuote.outputAmount * 95n) / 100n; // 5% slippage

    console.log(`Executing sell on ${sellQuote.dexName}...`);
    const sellTx = await sellRouterContract.swapExactTokensForTokens(
      sellQuote.inputAmount,
      minSellOutput,
      sellQuote.path,
      this.wallet.address,
      deadline
    );

    await sellTx.wait();

    return sellTx.hash;
  }
}
