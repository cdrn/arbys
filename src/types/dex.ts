export interface Token {
  address: string;
  symbol: string;
  decimals: number;
}

export interface PriceQuote {
  dexName: string;
  inputAmount: bigint;
  outputAmount: bigint;
  path: string[];
  estimatedGas: bigint;
  liquidity?: bigint; // Optional liquidity amount
  priceImpact?: number; // Optional price impact percentage
  poolAddress: string; // Address of the pool providing the quote
}

export interface DEXProtocol {
  name: string;
  router: string;
  factory: string;
  initCodeHash: string;
  version?: "v2" | "v3";
  quoter?: string; // For V3
  poolFees?: number[]; // For V3 fee tiers
}

export const SUPPORTED_DEXES: DEXProtocol[] = [
  {
    name: "Uniswap V2",
    router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    initCodeHash:
      "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f",
    version: "v2",
  },
  {
    name: "Uniswap V3",
    router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", // SwapRouter
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    initCodeHash:
      "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54",
    version: "v3",
    quoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6", // Quoter V2
    poolFees: [100, 500, 3000, 10000], // 0.01%, 0.05%, 0.3%, 1%
  },
];
