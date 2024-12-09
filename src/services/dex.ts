import { ethers } from "ethers";
import { Token, PriceQuote, DEXProtocol, SUPPORTED_DEXES } from "../types/dex";
import { MulticallService } from "./multicall";
import { logDebug, logError, logInfo } from "../utils/logger";

// Router ABI for trading functions
const ROUTER_ABI = [
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
];

export class DexService {
  private provider: ethers.Provider;
  private multicallService: MulticallService;
  private signer?: ethers.Signer;

  constructor(provider: ethers.Provider, privateKey?: string) {
    this.provider = provider;
    this.multicallService = new MulticallService(provider);
    if (privateKey) {
      this.signer = new ethers.Wallet(privateKey, provider);
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
      // Create all price check calls at once
      const priceChecks = SUPPORTED_DEXES.flatMap((dex) => [
        this.multicallService.createPairPriceCall(
          dex.router,
          tokenA.address,
          tokenB.address,
          amount
        ),
        this.multicallService.createPairPriceCall(
          dex.router,
          tokenB.address,
          tokenA.address,
          amount
        ),
      ]);

      // Execute all price checks in one multicall
      const priceResults = await this.multicallService.multicall(priceChecks);

      // Process results and create quotes
      const quotes: PriceQuote[] = [];
      for (let i = 0; i < priceResults.length; i += 2) {
        const dex = SUPPORTED_DEXES[Math.floor(i / 2)];
        const forwardResult = priceResults[i];
        const reverseResult = priceResults[i + 1];

        if (forwardResult.success) {
          const amounts = this.multicallService.decodePairPriceResult(
            forwardResult.returnData
          );
          if (amounts && amounts.length >= 2) {
            quotes.push({
              dexName: dex.name,
              inputAmount: amounts[0],
              outputAmount: amounts[1],
              path: [tokenA.address, tokenB.address],
              estimatedGas: BigInt(300000), // Estimated gas cost
            });
          }
        }

        if (reverseResult.success) {
          const amounts = this.multicallService.decodePairPriceResult(
            reverseResult.returnData
          );
          if (amounts && amounts.length >= 2) {
            quotes.push({
              dexName: dex.name,
              inputAmount: amounts[0],
              outputAmount: amounts[1],
              path: [tokenB.address, tokenA.address],
              estimatedGas: BigInt(300000), // Estimated gas cost
            });
          }
        }
      }

      // Filter valid quotes and find best arbitrage opportunity
      const validQuotes = quotes.filter(
        (quote) => quote.outputAmount > 0n && quote.inputAmount > 0n
      );

      let bestProfit = 0n;
      let bestRoute: PriceQuote[] = [];

      for (const quoteA of validQuotes) {
        for (const quoteB of validQuotes) {
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
      logError("Error finding arbitrage", error);
      return null;
    }
  }

  async executeArbitrage(
    tokenA: Token,
    tokenB: Token,
    amount: bigint,
    route: PriceQuote[]
  ): Promise<string> {
    if (!this.signer) {
      throw new Error("Signer not configured - cannot execute trades");
    }

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
      this.signer
    );

    // Approve both routers
    logInfo(`Approving ${tokenA.symbol} for trading...`);
    await tokenContract.approve(buyRouter, amount);
    await tokenContract.approve(sellRouter, amount);

    // Execute buy on first DEX
    const buyRouterContract = new ethers.Contract(
      buyRouter,
      ROUTER_ABI,
      this.signer
    );

    const minOutput = (buyQuote.outputAmount * 95n) / 100n; // 5% slippage
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60); // 1 minute

    logInfo(`Executing buy on ${buyQuote.dexName}...`);
    const buyTx = await buyRouterContract.swapExactTokensForTokens(
      buyQuote.inputAmount,
      minOutput,
      buyQuote.path,
      await this.signer.getAddress(),
      deadline
    );

    await buyTx.wait();

    // Execute sell on second DEX
    const sellRouterContract = new ethers.Contract(
      sellRouter,
      ROUTER_ABI,
      this.signer
    );

    const minSellOutput = (sellQuote.outputAmount * 95n) / 100n; // 5% slippage

    logInfo(`Executing sell on ${sellQuote.dexName}...`);
    const sellTx = await sellRouterContract.swapExactTokensForTokens(
      sellQuote.inputAmount,
      minSellOutput,
      sellQuote.path,
      await this.signer.getAddress(),
      deadline
    );

    await sellTx.wait();

    return sellTx.hash;
  }
}
