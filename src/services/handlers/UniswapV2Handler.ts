import { ethers } from "ethers";
import { Token, PriceQuote, DEXProtocol } from "../../types/dex";
import { BaseDexHandler } from "./BaseDexHandler";
import { logError, logInfo } from "../../utils/logger";

export class UniswapV2Handler extends BaseDexHandler {
  private async getPairAddress(
    tokenA: string,
    tokenB: string
  ): Promise<string> {
    try {
      const [token0, token1] =
        tokenA.toLowerCase() < tokenB.toLowerCase()
          ? [tokenA, tokenB]
          : [tokenB, tokenA];

      return ethers.getCreate2Address(
        this.dex.factory,
        ethers.keccak256(
          ethers.solidityPacked(["address", "address"], [token0, token1])
        ),
        this.dex.initCodeHash
      );
    } catch (error) {
      logError(
        `Failed to calculate V2 pair address: ${
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
    const pairAddress = await this.getPairAddress(
      tokenA.address,
      tokenB.address
    );

    // Check if pair exists
    const code = await this.provider.getCode(pairAddress);
    if (code === "0x") {
      logInfo(
        `No V2 pair exists for ${tokenA.symbol}/${tokenB.symbol} on ${this.dex.name}`
      );
      return quotes;
    }

    // Get quotes and liquidity
    const [forwardQuote, reverseQuote] = await Promise.all([
      this.multicallService.createPairPriceCall(
        this.dex.router,
        tokenA.address,
        tokenB.address,
        amount
      ),
      this.multicallService.createPairPriceCall(
        this.dex.router,
        tokenB.address,
        tokenA.address,
        amount
      ),
    ]);

    const results = await this.multicallService.multicall([
      forwardQuote,
      reverseQuote,
    ]);

    // Process forward quote
    if (results[0].success) {
      const amounts = this.multicallService.decodePairPriceResult(
        results[0].returnData
      );
      if (amounts && amounts.length >= 2 && amounts[1] > 0n) {
        quotes.push({
          dexName: this.dex.name,
          inputAmount: amounts[0],
          outputAmount: amounts[1],
          path: [tokenA.address, tokenB.address],
          estimatedGas: BigInt(300000),
        });
      }
    }

    // Process reverse quote
    if (results[1].success) {
      const amounts = this.multicallService.decodePairPriceResult(
        results[1].returnData
      );
      if (amounts && amounts.length >= 2 && amounts[1] > 0n) {
        quotes.push({
          dexName: this.dex.name,
          inputAmount: amounts[0],
          outputAmount: amounts[1],
          path: [tokenB.address, tokenA.address],
          estimatedGas: BigInt(300000),
        });
      }
    }

    return quotes;
  }
}
