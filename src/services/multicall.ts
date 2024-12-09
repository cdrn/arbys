import { ethers } from "ethers";
import { Interface } from "@ethersproject/abi";
import { logError, logInfo } from "../utils/logger";

// Multicall3 contract on Ethereum mainnet
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

const MULTICALL3_ABI = [
  "function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[])",
];

const ROUTER_INTERFACE = new Interface([
  "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)",
]);

const PAIR_INTERFACE = new Interface([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
]);

export interface MulticallRequest {
  target: string;
  allowFailure: boolean;
  callData: string;
}

interface MulticallResult {
  success: boolean;
  returnData: string;
}

export class MulticallService {
  private contract: ethers.Contract;

  constructor(provider: ethers.Provider) {
    try {
      this.contract = new ethers.Contract(
        MULTICALL3_ADDRESS,
        MULTICALL3_ABI,
        provider
      );
      logInfo("Multicall service initialized");
    } catch (error) {
      logError(
        `Failed to initialize Multicall service: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
      throw error;
    }
  }

  async multicall(calls: MulticallRequest[]): Promise<MulticallResult[]> {
    try {
      const simplifiedCalls = calls.map((call) => ({
        target: call.target,
        callData: call.callData,
      }));

      const results = await this.contract.tryAggregate(false, simplifiedCalls);

      return results.map((result: any) => ({
        success: result.success,
        returnData: result.returnData,
      }));
    } catch (error) {
      logError(
        `Multicall execution failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
      throw error;
    }
  }

  createPairPriceCall(
    routerAddress: string,
    tokenA: string,
    tokenB: string,
    amountIn: bigint
  ): MulticallRequest {
    try {
      const callData = ROUTER_INTERFACE.encodeFunctionData("getAmountsOut", [
        amountIn,
        [tokenA, tokenB],
      ]);

      return {
        target: routerAddress,
        allowFailure: true,
        callData,
      };
    } catch (error) {
      logError(`Failed to create price call - Router: ${routerAddress}`);
      throw error;
    }
  }

  decodePairPriceResult(returnData: string): bigint[] | null {
    if (!returnData || returnData === "0x") {
      return null;
    }

    try {
      const decoded = ROUTER_INTERFACE.decodeFunctionResult(
        "getAmountsOut",
        returnData
      );
      return decoded[0].map((amount: ethers.BigNumberish) =>
        BigInt(amount.toString())
      );
    } catch (error) {
      logError(
        `Failed to decode price result: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
      return null;
    }
  }

  createPairLiquidityCall(pairAddress: string): MulticallRequest {
    try {
      return {
        target: pairAddress,
        allowFailure: true,
        callData: PAIR_INTERFACE.encodeFunctionData("getReserves", []),
      };
    } catch (error) {
      logError(`Failed to create liquidity call for pair: ${pairAddress}`);
      throw error;
    }
  }

  decodePairLiquidityResult(
    returnData: string
  ): { reserve0: bigint; reserve1: bigint } | null {
    if (!returnData || returnData === "0x") {
      return null;
    }

    try {
      const decoded = PAIR_INTERFACE.decodeFunctionResult(
        "getReserves",
        returnData
      );
      return {
        reserve0: BigInt(decoded.reserve0.toString()),
        reserve1: BigInt(decoded.reserve1.toString()),
      };
    } catch (error) {
      logError(
        `Failed to decode liquidity result: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
      return null;
    }
  }
}
