import { ethers } from "ethers";
import { Token, PriceQuote, DEXProtocol } from "../types/dex";
import {
  ArbitrageOpportunity,
  TradeResult,
  TradeValidation,
} from "../types/trade";
import { logError, logInfo } from "../utils/logger";
import { DexService } from "./dex";

// ERC20 interface for token approvals
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
];

// Uniswap V2 Router interface
const V2_ROUTER_ABI = [
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
];

// Uniswap V3 Router interface
const V3_ROUTER_ABI = [
  "function exactInput(tuple(bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params) external payable returns (uint256 amountOut)",
];

export class TradeExecutor {
  private provider: ethers.Provider;
  private signer: ethers.Signer;
  private dexService: DexService;
  private maxSlippagePercent: number;
  private maxGasPrice: bigint;

  constructor(
    provider: ethers.Provider,
    privateKey: string,
    dexService: DexService,
    maxSlippagePercent: number = 1.0,
    maxGasGwei: number = 50
  ) {
    this.provider = provider;
    this.signer = new ethers.Wallet(privateKey, provider);
    this.dexService = dexService;
    this.maxSlippagePercent = maxSlippagePercent;
    this.maxGasPrice = ethers.parseUnits(maxGasGwei.toString(), "gwei");
  }

  async validateArbitrage(
    opportunity: ArbitrageOpportunity
  ): Promise<TradeValidation> {
    try {
      // Check gas price
      const gasPrice = await this.provider.getFeeData();
      if (!gasPrice.gasPrice || gasPrice.gasPrice > this.maxGasPrice) {
        return {
          isValid: false,
          reason: `Gas price too high: ${ethers.formatUnits(
            gasPrice.gasPrice || 0,
            "gwei"
          )} gwei`,
        };
      }

      // Get fresh quotes
      const [updatedBuyQuote, updatedSellQuote] = await Promise.all([
        this.dexService
          .getHandlers()
          .get(opportunity.buyQuote.dexName.split(" ")[0])
          ?.getQuotes(
            opportunity.tokenA,
            opportunity.tokenB,
            opportunity.buyQuote.inputAmount
          ),
        this.dexService
          .getHandlers()
          .get(opportunity.sellQuote.dexName.split(" ")[0])
          ?.getQuotes(
            opportunity.tokenA,
            opportunity.tokenB,
            opportunity.buyQuote.outputAmount
          ),
      ]);

      if (!updatedBuyQuote?.[0] || !updatedSellQuote?.[0]) {
        return {
          isValid: false,
          reason: "Failed to get updated quotes",
        };
      }

      // Calculate slippage
      const buySlippage =
        (Number(
          opportunity.buyQuote.outputAmount - updatedBuyQuote[0].outputAmount
        ) /
          Number(opportunity.buyQuote.outputAmount)) *
        100;
      const sellSlippage =
        (Number(
          opportunity.sellQuote.outputAmount - updatedSellQuote[0].outputAmount
        ) /
          Number(opportunity.sellQuote.outputAmount)) *
        100;

      if (
        buySlippage > this.maxSlippagePercent ||
        sellSlippage > this.maxSlippagePercent
      ) {
        return {
          isValid: false,
          reason: `Slippage too high: Buy ${buySlippage.toFixed(
            2
          )}%, Sell ${sellSlippage.toFixed(2)}%`,
          updatedBuyQuote: updatedBuyQuote[0],
          updatedSellQuote: updatedSellQuote[0],
        };
      }

      // Estimate gas costs
      const estimatedGas =
        updatedBuyQuote[0].estimatedGas + updatedSellQuote[0].estimatedGas;
      const estimatedGasCost = estimatedGas * (gasPrice.gasPrice || 0n);
      const estimatedNetProfit =
        updatedSellQuote[0].outputAmount -
        updatedBuyQuote[0].inputAmount -
        estimatedGasCost;

      return {
        isValid: estimatedNetProfit > 0n,
        reason:
          estimatedNetProfit > 0n ? undefined : "Not profitable after gas",
        updatedBuyQuote: updatedBuyQuote[0],
        updatedSellQuote: updatedSellQuote[0],
        estimatedGasCost,
        estimatedNetProfit,
      };
    } catch (error) {
      logError("Error validating arbitrage", error);
      return {
        isValid: false,
        reason: `Validation error: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      };
    }
  }

  async executeTrade(opportunity: ArbitrageOpportunity): Promise<TradeResult> {
    try {
      // Validate first
      const validation = await this.validateArbitrage(opportunity);
      if (!validation.isValid) {
        return {
          success: false,
          error: validation.reason,
        };
      }

      // Check and set allowances if needed
      await this.ensureAllowance(
        opportunity.tokenA,
        opportunity.buyQuote.dexName.split(" ")[0],
        opportunity.buyQuote.inputAmount
      );

      // Execute trades
      const buyTx = await this.executeSwap(opportunity.buyQuote);
      if (!buyTx.success) {
        return buyTx;
      }

      await this.ensureAllowance(
        opportunity.tokenB,
        opportunity.sellQuote.dexName.split(" ")[0],
        opportunity.sellQuote.inputAmount
      );

      const sellTx = await this.executeSwap(opportunity.sellQuote);
      if (!sellTx.success) {
        return sellTx;
      }

      // Calculate actual profit
      const totalGasCost =
        (buyTx.gasUsed || 0n) * (buyTx.effectiveGasPrice || 0n) +
        (sellTx.gasUsed || 0n) * (sellTx.effectiveGasPrice || 0n);

      return {
        success: true,
        transactionHash: sellTx.transactionHash,
        gasUsed: (buyTx.gasUsed || 0n) + (sellTx.gasUsed || 0n),
        effectiveGasPrice: sellTx.effectiveGasPrice,
        totalCost: totalGasCost,
        actualProfit:
          opportunity.sellQuote.outputAmount -
          opportunity.buyQuote.inputAmount -
          totalGasCost,
      };
    } catch (error) {
      logError("Error executing trade", error);
      return {
        success: false,
        error: `Execution error: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      };
    }
  }

  private async ensureAllowance(
    token: Token,
    spender: string,
    amount: bigint
  ): Promise<void> {
    const tokenContract = new ethers.Contract(
      token.address,
      ERC20_ABI,
      this.signer
    );
    const currentAllowance = await tokenContract.allowance(
      await this.signer.getAddress(),
      spender
    );

    if (currentAllowance < amount) {
      logInfo(`Setting allowance for ${token.symbol}`);
      const tx = await tokenContract.approve(spender, ethers.MaxUint256);
      await tx.wait();
    }
  }

  private async executeSwap(quote: PriceQuote): Promise<TradeResult> {
    try {
      const dex = this.dexService.getDexByName(quote.dexName.split(" ")[0]);
      if (!dex) {
        throw new Error(`DEX not found: ${quote.dexName}`);
      }

      // Calculate minimum output with slippage protection
      const minOutput =
        (quote.outputAmount *
          BigInt(10000 - Math.floor(this.maxSlippagePercent * 100))) /
        10000n;
      const deadline = Math.floor(Date.now() / 1000) + 300; // 5 minutes

      let tx;
      if (dex.version === "v2") {
        // Execute V2 swap
        const router = new ethers.Contract(
          dex.router,
          V2_ROUTER_ABI,
          this.signer
        );
        tx = await router.swapExactTokensForTokens(
          quote.inputAmount,
          minOutput,
          quote.path,
          await this.signer.getAddress(),
          deadline
        );
      } else if (dex.version === "v3") {
        // Execute V3 swap
        const router = new ethers.Contract(
          dex.router,
          V3_ROUTER_ABI,
          this.signer
        );

        // Encode path for V3 (includes fee tiers)
        const fee = Number(quote.dexName.match(/\(([\d.]+)%\)/)?.[1]) * 10000;
        const encodedPath = ethers.solidityPacked(
          ["address", "uint24", "address"],
          [quote.path[0], fee, quote.path[1]]
        );

        tx = await router.exactInput({
          path: encodedPath,
          recipient: await this.signer.getAddress(),
          deadline,
          amountIn: quote.inputAmount,
          amountOutMinimum: minOutput,
        });
      } else {
        throw new Error(`Unsupported DEX version: ${dex.version}`);
      }

      const receipt = await tx.wait();
      return {
        success: true,
        transactionHash: receipt.hash,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.gasPrice,
      };
    } catch (error) {
      return {
        success: false,
        error: `Swap error: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      };
    }
  }
}
