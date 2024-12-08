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
}

export interface DEXProtocol {
  name: string;
  router: string;
  factory: string;
  initCodeHash: string;
}

export const SUPPORTED_DEXES: DEXProtocol[] = [
  {
    name: "Uniswap V2",
    router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    initCodeHash:
      "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f",
  },
  {
    name: "Sushiswap",
    router: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
    factory: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac",
    initCodeHash:
      "0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303",
  },
  {
    name: "Shibaswap",
    router: "0x03f7724180AA6b939894B5Ca4314783B0b36b329",
    factory: "0x115934131916C8b277DD010Ee02de363c09d037c",
    initCodeHash:
      "0x65d1a3b1e46c6e4f1be1ad5f99ef14dc488ae0549dc97db9b30afe2241ce1c7a",
  },
];
