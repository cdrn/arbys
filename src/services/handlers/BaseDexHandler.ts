import { Token, PriceQuote, DEXProtocol } from "../../types/dex";
import { MulticallService } from "../multicall";
import { ethers } from "ethers";

export abstract class BaseDexHandler {
  protected provider: ethers.Provider;
  protected multicallService: MulticallService;
  protected dex: DEXProtocol;

  constructor(provider: ethers.Provider, dex: DEXProtocol) {
    this.provider = provider;
    this.multicallService = new MulticallService(provider);
    this.dex = dex;
  }

  abstract getQuotes(
    tokenA: Token,
    tokenB: Token,
    amount: bigint
  ): Promise<PriceQuote[]>;
}
