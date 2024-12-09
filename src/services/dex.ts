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
const MIN_LIQUIDITY_USD = 10000n; // $10k minimum liquidity
const MAX_PRICE_IMPACT = 2; // 2% max price impact

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

export class DexService {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;

  constructor(provider: ethers.JsonRpcProvider, privateKey: string) {
    this.provider = provider;
    this.wallet = new ethers.Wallet(privateKey, provider);
  }

  private formatReserve(amount: bigint, decimals: number): string {
    return ethers.formatUnits(amount, decimals);
  }

  private async getPoolInfo(
    dex: (typeof SUPPORTED_DEXES)[0],
    tokenA: Token,
    tokenB: Token
  ): Promise<PoolInfo | null> {
    try {
      const factory = new ethers.Contract(
        dex.factory,
        FACTORY_ABI,
        this.provider
      );
      const pairAddress = await factory.getPair(tokenA.address, tokenB.address);

      if (pairAddress === "0x0000000000000000000000000000000000000000") {
        console.log(
          `No pool found for ${tokenA.symbol}/${tokenB.symbol} on ${dex.name}`
        );
        return null;
      }

      const pair = new ethers.Contract(pairAddress, PAIR_ABI, this.provider);
      const [reserve0, reserve1] = await pair.getReserves();
      const token0 = await pair.token0();
      const token1 = await pair.token1();

      // Log pool reserves
      const token0Decimals =
        token0.toLowerCase() === tokenA.address.toLowerCase()
          ? tokenA.decimals
          : tokenB.decimals;
      const token1Decimals =
        token1.toLowerCase() === tokenA.address.toLowerCase()
          ? tokenB.decimals
          : tokenA.decimals;
      console.log(`\n${dex.name} Pool (${pairAddress}):`);
      console.log(
        `Reserve0: ${this.formatReserve(reserve0, token0Decimals)} ${
          token0.toLowerCase() === tokenA.address.toLowerCase()
            ? tokenA.symbol
            : tokenB.symbol
        }`
      );
      console.log(
        `Reserve1: ${this.formatReserve(reserve1, token1Decimals)} ${
          token1.toLowerCase() === tokenA.address.toLowerCase()
            ? tokenA.symbol
            : tokenB.symbol
        }`
      );

      return {
        reserve0,
        reserve1,
        token0,
        token1,
        pairAddress,
      };
    } catch (error) {
      console.error(`Error getting pool info for ${dex.name}:`, error);
      return null;
    }
  }

  private calculatePriceImpact(
    amountIn: bigint,
    reserveIn: bigint,
    reserveOut: bigint
  ): number {
    // Using constant product formula (x * y = k)
    const amountInWithFee = amountIn * 997n; // 0.3% fee
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * 1000n + amountInWithFee;
    const amountOut = numerator / denominator;

    // Calculate price impact
    const exactQuote = (amountIn * reserveOut) / reserveIn;
    const priceImpact =
      (Number(exactQuote - amountOut) / Number(exactQuote)) * 100;
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
    const reserveUsdValue = tokenB.symbol.includes("USD")
      ? reserveB
      : reserveB * 1500n; // Rough ETH price estimate for non-USD pairs

    // Check minimum liquidity
    if (reserveUsdValue < MIN_LIQUIDITY_USD) {
      console.log(
        `Insufficient USD liquidity: $${ethers.formatUnits(
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

  async getPriceQuotes(
    tokenIn: Token,
    tokenOut: Token,
    amountIn: bigint
  ): Promise<PriceQuote[]> {
    const quotes: PriceQuote[] = [];

    for (const dex of SUPPORTED_DEXES) {
      try {
        // First check pool liquidity
        const poolInfo = await this.getPoolInfo(dex, tokenIn, tokenOut);
        if (!poolInfo) continue;

        // Check if pool has enough liquidity
        if (!this.hasEnoughLiquidity(poolInfo, tokenIn, tokenOut, amountIn)) {
          continue;
        }

        const router = new ethers.Contract(
          dex.router,
          ROUTER_ABI,
          this.provider
        );

        const [amounts, estimatedGas] = await Promise.all([
          router.getAmountsOut(amountIn, [tokenIn.address, tokenOut.address]),
          router.getAmountsOut.estimateGas(amountIn, [
            tokenIn.address,
            tokenOut.address,
          ]),
        ]);

        // Calculate profit percentage
        const outputAmount = amounts[1];
        const profitPercentage =
          Number((outputAmount * 10000n) / amountIn) / 100 - 100;

        if (profitPercentage > MAX_PROFIT_THRESHOLD) {
          console.log(
            `Skipping suspicious price on ${
              dex.name
            }: ${profitPercentage.toFixed(2)}% profit seems too high`
          );
          continue;
        }

        console.log(
          `${dex.name} quote: ${this.formatReserve(
            outputAmount,
            tokenOut.decimals
          )} ${tokenOut.symbol} (${profitPercentage.toFixed(2)}% profit)`
        );

        quotes.push({
          dexName: dex.name,
          inputAmount: amountIn,
          outputAmount,
          path: [tokenIn.address, tokenOut.address],
          estimatedGas,
        });
      } catch (error) {
        console.error(`Error fetching quote from ${dex.name}:`, error);
      }
    }

    return quotes;
  }

  async findArbitrage(
    tokenA: Token,
    tokenB: Token,
    amount: bigint
  ): Promise<ArbitrageOpportunity | null> {
    const quotes = await this.getPriceQuotes(tokenA, tokenB, amount);

    // Need at least 2 quotes to compare
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

    // Sanity check: if profit is too good to be true (>10%), skip it
    if (profitPercentage > 10) {
      console.log(
        `Skipping suspicious arbitrage: ${profitPercentage}% profit seems too good to be true`
      );
      return null;
    }

    // Convert gas cost to token terms (simplified)
    if (profit > gasCostInEth) {
      return {
        profit,
        route: [bestBuy, bestSell],
        requiredCapital: bestBuy.inputAmount,
        profitPercentage,
        estimatedGasCost: gasCostInEth,
        priceImpact: 0,
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
