import { ethers } from "ethers";
import { Token, PriceQuote, DEXProtocol } from "../../types/dex";
import { BaseDexHandler } from "./BaseDexHandler";
import { logError, logInfo } from "../../utils/logger";

export class UniswapV3Handler extends BaseDexHandler {
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

    if (!this.dex.poolFees || !this.dex.quoter) {
      logError(`Missing pool fees or quoter for ${this.dex.name}`);
      return quotes;
    }

    // Check each fee tier
    for (const fee of this.dex.poolFees) {
      const poolAddress = await this.getPoolAddress(
        tokenA.address,
        tokenB.address,
        fee
      );

      // Check if pool exists
      const code = await this.provider.getCode(poolAddress);
      if (code === "0x") {
        logInfo(
          `No V3 pool exists for ${tokenA.symbol}/${tokenB.symbol} with fee ${
            fee / 10000
          }% on ${this.dex.name}`
        );
        continue;
      }

      // Get quotes using V3 quoter
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
        const amountOut = this.multicallService.decodePairPriceResult(
          results[0].returnData,
          true
        );
        if (amountOut && amountOut[0] > 0n) {
          quotes.push({
            dexName: `${this.dex.name} ${fee / 10000}%`,
            inputAmount: amount,
            outputAmount: amountOut[0],
            path: [tokenA.address, tokenB.address],
            estimatedGas: BigInt(200000), // V3 typically uses less gas
          });
        }
      }

      // Process reverse quote
      if (results[1].success) {
        const amountOut = this.multicallService.decodePairPriceResult(
          results[1].returnData,
          true
        );
        if (amountOut && amountOut[0] > 0n) {
          quotes.push({
            dexName: `${this.dex.name} ${fee / 10000}%`,
            inputAmount: amount,
            outputAmount: amountOut[0],
            path: [tokenB.address, tokenA.address],
            estimatedGas: BigInt(200000),
          });
        }
      }
    }

    return quotes;
  }
}
