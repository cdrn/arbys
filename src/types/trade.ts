import { Token, PriceQuote } from "./dex";

export interface ArbitrageOpportunity {
  tokenA: Token;
  tokenB: Token;
  buyQuote: PriceQuote;
  sellQuote: PriceQuote;
  profitPercent: number;
  profitAmount: number;
  timestamp: number;
}

export interface TradeResult {
  success: boolean;
  transactionHash?: string;
  error?: string;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  totalCost?: bigint;
  actualProfit?: bigint;
}

export interface TradeValidation {
  isValid: boolean;
  reason?: string;
  updatedBuyQuote?: PriceQuote;
  updatedSellQuote?: PriceQuote;
  estimatedGasCost?: bigint;
  estimatedNetProfit?: bigint;
}
