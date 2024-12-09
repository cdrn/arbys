import { ethers } from "ethers";
import { Interface } from "@ethersproject/abi";
import { logDebug, logError, logInfo } from "../utils/logger";

// Multicall3 contract on Ethereum mainnet
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

const MULTICALL3_ABI = [
  "function aggregate3Static(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[])",
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
      logDebug(`Executing multicall with ${calls.length} calls`);

      // Convert to simpler tryAggregate format
      const simplifiedCalls = calls.map((call) => ({
        target: call.target,
        callData: call.callData,
      }));

      // Use tryAggregate instead of aggregate3Static for better compatibility
      const results = await this.contract.tryAggregate(false, simplifiedCalls);

      const typedResults: MulticallResult[] = results.map(
        (result: any, index: number) => {
          if (!result.success) {
            logError(
              `Multicall request failed - Target: ${calls[index].target}, Index: ${index}, Data: ${result.returnData}`
            );
          } else {
            logDebug(
              `Multicall request succeeded - Target: ${calls[index].target}, Index: ${index}`
            );
          }
          return {
            success: result.success,
            returnData: result.returnData,
          };
        }
      );

      return typedResults;
    } catch (error) {
      logError(
        `Multicall execution failed: ${
          error instanceof Error ? error.message : "Unknown error"
        } (${calls.length} calls)`
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

      logDebug(
        `Creating price call - Router: ${routerAddress}, Path: ${tokenA} -> ${tokenB}, Amount: ${amountIn.toString()}`
      );

      return {
        target: routerAddress,
        allowFailure: true,
        callData,
      };
    } catch (error) {
      logError(
        `Failed to create pair price call - Router: ${routerAddress}, TokenA: ${tokenA}, TokenB: ${tokenB}, AmountIn: ${amountIn.toString()}`
      );
      throw error;
    }
  }

  decodePairPriceResult(returnData: string): bigint[] | null {
    if (!returnData || returnData === "0x") {
      logDebug(`Empty return data for price check: ${returnData}`);
      return null;
    }

    try {
      const decoded = ROUTER_INTERFACE.decodeFunctionResult(
        "getAmountsOut",
        returnData
      );
      const amounts = decoded[0].map((amount: ethers.BigNumberish) =>
        BigInt(amount.toString())
      );
      logDebug(
        `Successfully decoded price result: ${amounts
          .map((amount: bigint) => amount.toString())
          .join(", ")}`
      );
      return amounts;
    } catch (error) {
      logError(
        `Failed to decode price result: ${
          error instanceof Error ? error.message : "Unknown error"
        }, Data: ${returnData}`
      );
      return null;
    }
  }

  createPairLiquidityCall(pairAddress: string): MulticallRequest {
    try {
      const callData = PAIR_INTERFACE.encodeFunctionData("getReserves", []);

      logDebug(`Creating liquidity call for pair: ${pairAddress}`);

      return {
        target: pairAddress,
        allowFailure: true,
        callData,
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
      logDebug(`Empty return data for liquidity check: ${returnData}`);
      return null;
    }

    try {
      const decoded = PAIR_INTERFACE.decodeFunctionResult(
        "getReserves",
        returnData
      );
      const result = {
        reserve0: BigInt(decoded.reserve0.toString()),
        reserve1: BigInt(decoded.reserve1.toString()),
      };
      logDebug(
        `Successfully decoded liquidity - Reserve0: ${result.reserve0.toString()}, Reserve1: ${result.reserve1.toString()}`
      );
      return result;
    } catch (error) {
      logError(
        `Failed to decode liquidity result: ${
          error instanceof Error ? error.message : "Unknown error"
        }, Data: ${returnData}`
      );
      return null;
    }
  }
}
