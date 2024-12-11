import { Token, PriceQuote, DEXProtocol } from "../../types/dex";
import { MulticallService } from "../multicall";
import { ethers } from "ethers";

export abstract class BaseDexHandler {
  protected provider: ethers.Provider;
  protected multicallService: MulticallService;
  protected dex: DEXProtocol;
  protected nonExistentPools: Set<string>;

  constructor(provider: ethers.Provider, dex: DEXProtocol) {
    this.provider = provider;
    this.multicallService = new MulticallService(provider);
    this.dex = dex;
    this.nonExistentPools = new Set();
  }

  protected getCacheKey(tokenA: string, tokenB: string, fee?: number): string {
    const [token0, token1] =
      tokenA.toLowerCase() < tokenB.toLowerCase()
        ? [tokenA, tokenB]
        : [tokenB, tokenA];
    return fee ? `${token0}-${token1}-${fee}` : `${token0}-${token1}`;
  }

  abstract getQuotes(
    tokenA: Token,
    tokenB: Token,
    amount: bigint
  ): Promise<PriceQuote[]>;
}
