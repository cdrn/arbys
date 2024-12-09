import axios from "axios";
import { logArb, logError, logInfo, logDebug } from "../utils/logger";

export interface CEXPrice {
  exchange: string;
  price: number;
  bidSize: number;
  askSize: number;
  timestamp: number;
}

export class CEXService {
  private binanceUrl = "https://api.binance.com/api/v3";

  async getBinancePrice(symbol: string): Promise<CEXPrice | null> {
    try {
      logDebug(`Fetching Binance price for ${symbol}...`);

      const [tickerRes, depthRes] = await Promise.all([
        axios.get(`${this.binanceUrl}/ticker/price?symbol=${symbol}`),
        axios.get(`${this.binanceUrl}/depth?symbol=${symbol}&limit=5`),
      ]);

      const price = parseFloat(tickerRes.data.price);
      const bestBid = depthRes.data.bids[0];
      const bestAsk = depthRes.data.asks[0];

      const result = {
        exchange: "Binance",
        price,
        bidSize: parseFloat(bestBid[1]),
        askSize: parseFloat(bestAsk[1]),
        timestamp: Date.now(),
      };

      logInfo(
        `Binance ${symbol}: Price=${price}, Bid Size=${result.bidSize}, Ask Size=${result.askSize}`
      );
      return result;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        logError(`Binance API error for ${symbol}`, err.response.data);
      } else {
        logError(`Error fetching Binance price for ${symbol}`, err);
      }
      return null;
    }
  }

  async getAllPrices(symbol: string): Promise<CEXPrice[]> {
    const binance = await this.getBinancePrice(symbol);
    return binance ? [binance] : [];
  }

  findArbitrage(
    dexPrice: number,
    cexPrices: CEXPrice[],
    minProfitPercent: number = 0.5
  ): {
    profitPercent: number;
    direction: "BUY_DEX_SELL_CEX" | "BUY_CEX_SELL_DEX";
    cex: string;
  } | null {
    for (const cex of cexPrices) {
      // Check if we can buy on DEX and sell on CEX
      const dexToCexProfit = ((cex.price - dexPrice) / dexPrice) * 100;
      if (dexToCexProfit > minProfitPercent) {
        logArb(
          `Found DEX->CEX arbitrage: ${dexToCexProfit.toFixed(2)}% profit`
        );
        logArb(`DEX price: ${dexPrice}, CEX price: ${cex.price}`);
        return {
          profitPercent: dexToCexProfit,
          direction: "BUY_DEX_SELL_CEX",
          cex: cex.exchange,
        };
      }

      // Check if we can buy on CEX and sell on DEX
      const cexToDexProfit = ((dexPrice - cex.price) / cex.price) * 100;
      if (cexToDexProfit > minProfitPercent) {
        logArb(
          `Found CEX->DEX arbitrage: ${cexToDexProfit.toFixed(2)}% profit`
        );
        logArb(`CEX price: ${cex.price}, DEX price: ${dexPrice}`);
        return {
          profitPercent: cexToDexProfit,
          direction: "BUY_CEX_SELL_DEX",
          cex: cex.exchange,
        };
      }
    }

    return null;
  }
}
