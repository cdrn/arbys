import { ethers } from "ethers";
import { Token, PriceQuote, SUPPORTED_DEXES } from "../types/dex";

// Uniswap V2 Router ABI (only the functions we need)
const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
];

export class DexService {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;

  constructor(provider: ethers.JsonRpcProvider, privateKey: string) {
    this.provider = provider;
    this.wallet = new ethers.Wallet(privateKey, provider);
  }

  async getPriceQuotes(
    tokenIn: Token,
    tokenOut: Token,
    amountIn: bigint
  ): Promise<PriceQuote[]> {
    const quotes: PriceQuote[] = [];

    for (const dex of SUPPORTED_DEXES) {
      try {
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

        quotes.push({
          dexName: dex.name,
          inputAmount: amountIn,
          outputAmount: amounts[1],
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
  ): Promise<{
    profit: bigint;
    route: PriceQuote[];
  } | null> {
    const quotes = await this.getPriceQuotes(tokenA, tokenB, amount);

    // Sort quotes by output amount (descending)
    quotes.sort((a, b) => Number(b.outputAmount - a.outputAmount));

    if (quotes.length < 2) return null;

    const bestBuy = quotes[0];
    const bestSell = quotes[1];

    const profit = bestSell.outputAmount - bestBuy.inputAmount;

    // Check if profit exceeds gas costs
    const totalGas = bestBuy.estimatedGas + bestSell.estimatedGas;
    const gasPrice = (await this.provider.getFeeData()).gasPrice || 0n;
    const gasCostInEth = totalGas * gasPrice;

    // Convert gas cost to token terms (simplified)
    if (profit > gasCostInEth) {
      return {
        profit,
        route: [bestBuy, bestSell],
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

    // First approve tokens if needed
    const tokenContract = new ethers.Contract(
      tokenA.address,
      [
        "function approve(address spender, uint256 amount) external returns (bool)",
      ],
      this.wallet
    );

    // Approve both routers
    await tokenContract.approve(buyQuote.dexName, amount);
    await tokenContract.approve(sellQuote.dexName, amount);

    // Execute buy on first DEX
    const buyRouter = new ethers.Contract(
      SUPPORTED_DEXES.find((d) => d.name === buyQuote.dexName)!.router,
      ROUTER_ABI,
      this.wallet
    );

    const minOutput = (buyQuote.outputAmount * 95n) / 100n; // 5% slippage
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60); // 1 minute

    const buyTx = await buyRouter.swapExactTokensForTokens(
      buyQuote.inputAmount,
      minOutput,
      buyQuote.path,
      this.wallet.address,
      deadline
    );

    await buyTx.wait();

    // Execute sell on second DEX
    const sellRouter = new ethers.Contract(
      SUPPORTED_DEXES.find((d) => d.name === sellQuote.dexName)!.router,
      ROUTER_ABI,
      this.wallet
    );

    const minSellOutput = (sellQuote.outputAmount * 95n) / 100n; // 5% slippage

    const sellTx = await sellRouter.swapExactTokensForTokens(
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
