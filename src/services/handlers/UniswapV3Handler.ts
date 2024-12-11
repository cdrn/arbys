import { ethers } from "ethers";
import { Token, PriceQuote, DEXProtocol } from "../../types/dex";
import { BaseDexHandler } from "./BaseDexHandler";
import { logError, logInfo } from "../../utils/logger";

export class UniswapV3Handler extends BaseDexHandler {
  constructor(provider: ethers.Provider, dex: DEXProtocol) {
    super(provider, dex);
    if (!dex.quoter || !dex.poolFees) {
      throw new Error(
        `${dex.name} configuration is missing quoter or poolFees`
      );
    }
  }

  private async getPoolAddress(
    tokenA: string,
    tokenB: string,
    fee: number
  ): Promise<string> {
    try {
      const [token0, token1] =
        tokenA.toLowerCase() < tokenB.toLowerCase()
          ? [tokenA, tokenB]
          : [tokenB, tokenA];

      return ethers.getCreate2Address(
        this.dex.factory,
        ethers.keccak256(
          ethers.solidityPacked(
            ["address", "address", "uint24"],
            [token0, token1, fee]
          )
        ),
        this.dex.initCodeHash
      );
    } catch (error) {
      logError(
        `Failed to calculate V3 pool address: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
      throw error;
    }
  }

  async getQuotes(
    tokenA: Token,
    tokenB: Token,
    amount: bigint
  ): Promise<PriceQuote[]> {
    const quotes: PriceQuote[] = [];

    if (!this.dex.quoter || !this.dex.poolFees) {
      logError(`${this.dex.name} is missing quoter or poolFees configuration`);
      return quotes;
    }

    for (const fee of this.dex.poolFees) {
      // Check cache first
      const cacheKey = this.getCacheKey(tokenA.address, tokenB.address, fee);
      if (this.nonExistentPools.has(cacheKey)) {
        logInfo(
          `Skipping known non-existent pool ${tokenA.symbol}/${tokenB.symbol} (${fee}) on ${this.dex.name}`
        );
        continue;
      }

      try {
        const poolAddress = await this.getPoolAddress(
          tokenA.address,
          tokenB.address,
          fee
        );

        // Check if pool exists
        const code = await this.provider.getCode(poolAddress);
        if (code === "0x") {
          logInfo(
            `No V3 pool exists for ${tokenA.symbol}/${tokenB.symbol} (${fee}) on ${this.dex.name}`
          );
          // Cache the non-existent pool
          this.nonExistentPools.add(cacheKey);
          continue;
        }

        const [forwardQuote, reverseQuote] = await Promise.all([
          this.multicallService.createPairPriceCall(
            this.dex.quoter,
            tokenA.address,
            tokenB.address,
            amount,
            true,
            fee
          ),
          this.multicallService.createPairPriceCall(
            this.dex.quoter,
            tokenB.address,
            tokenA.address,
            amount,
            true,
            fee
          ),
        ]);

        const results = await this.multicallService.multicall([
          forwardQuote,
          reverseQuote,
        ]);

        // Process forward quote
        if (results[0].success) {
          const amounts = this.multicallService.decodePairPriceResult(
            results[0].returnData,
            true
          );
          if (amounts && amounts.length >= 1 && amounts[0] > 0n) {
            const price = Number(amounts[0]) / Number(amount);
            logInfo(
              `${tokenA.symbol}->${tokenB.symbol} (${fee}) on ${
                this.dex.name
              } (${poolAddress}): ${price.toFixed(6)}`
            );
            quotes.push({
              dexName: `${this.dex.name} (${(fee / 10000).toFixed(2)}%)`,
              inputAmount: amount,
              outputAmount: amounts[0],
              path: [tokenA.address, tokenB.address],
              estimatedGas: BigInt(300000),
              poolAddress,
            });
          }
        }

        // Process reverse quote
        if (results[1].success) {
          const amounts = this.multicallService.decodePairPriceResult(
            results[1].returnData,
            true
          );
          if (amounts && amounts.length >= 1 && amounts[0] > 0n) {
            const price = Number(amounts[0]) / Number(amount);
            logInfo(
              `${tokenB.symbol}->${tokenA.symbol} (${fee}) on ${
                this.dex.name
              } (${poolAddress}): ${price.toFixed(6)}`
            );
            quotes.push({
              dexName: `${this.dex.name} (${(fee / 10000).toFixed(2)}%)`,
              inputAmount: amount,
              outputAmount: amounts[0],
              path: [tokenB.address, tokenA.address],
              estimatedGas: BigInt(300000),
              poolAddress,
            });
          }
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("pool not found")
        ) {
          // Cache the non-existent pool
          this.nonExistentPools.add(cacheKey);
          logInfo(
            `No V3 pool exists for ${tokenA.symbol}/${tokenB.symbol} (${fee}) on ${this.dex.name}`
          );
        } else {
          logError(
            `Error getting V3 quotes for ${tokenA.symbol}/${tokenB.symbol} (${fee})`,
            error
          );
        }
      }
    }

    return quotes;
  }
}
