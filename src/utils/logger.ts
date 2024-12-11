import winston from "winston";
import { format } from "winston";

const { combine, timestamp, colorize, printf } = format;

const customLevels = {
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    arb: 3,
    price: 4,
    debug: 5,
  },
  colors: {
    error: "red",
    warn: "yellow",
    info: "white",
    arb: "green",
    price: "cyan",
    debug: "blue",
  },
};

// Add custom colors
winston.addColors(customLevels.colors);

const logFormat = printf((info) => {
  const { timestamp, level, message } = info;
  return `${timestamp} [${level}]: ${message}`;
});

// Create base logger configuration
const createLogger = (filename: string) => {
  return winston.createLogger({
    levels: customLevels.levels,
    level: "debug",
    format: combine(timestamp(), colorize({ all: true }), logFormat),
    transports: [
      new winston.transports.Console({
        format: combine(timestamp(), colorize({ all: true }), logFormat),
      }),
      new winston.transports.File({
        filename: `logs/${filename}.log`,
        format: combine(timestamp(), format.uncolorize(), logFormat),
      }),
    ],
  });
};

// Create separate loggers
export const priceLogger = createLogger("price");
export const arbLogger = createLogger("arbitrage");
export const mainLogger = createLogger("main");

// Convenience methods for price logging
export const logPrice = (message: string) => priceLogger.log("price", message);
export const logPriceError = (message: string, error?: any) => {
  if (error) {
    priceLogger.error(message, { error: error.message || error });
  } else {
    priceLogger.error(message);
  }
};
export const logPriceInfo = (message: string) => priceLogger.info(message);
export const logPriceDebug = (message: string) => priceLogger.debug(message);
export const logPriceWarn = (message: string) => priceLogger.warn(message);

// Convenience methods for arbitrage logging
export const logArb = (message: string) => arbLogger.log("arb", message);
export const logArbError = (message: string, error?: any) => {
  if (error) {
    arbLogger.error(message, { error: error.message || error });
  } else {
    arbLogger.error(message);
  }
};
export const logArbInfo = (message: string) => arbLogger.info(message);
export const logArbDebug = (message: string) => arbLogger.debug(message);
export const logArbWarn = (message: string) => arbLogger.warn(message);

// General logging methods
export const logError = (message: string, error?: any) => {
  if (error) {
    mainLogger.error(message, { error: error.message || error });
  } else {
    mainLogger.error(message);
  }
};
export const logInfo = (message: string) => mainLogger.info(message);
export const logDebug = (message: string) => mainLogger.debug(message);
export const logWarn = (message: string) => mainLogger.warn(message);
