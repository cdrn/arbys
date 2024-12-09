import winston from "winston";
import { format } from "winston";

const { combine, timestamp, colorize, printf } = format;

const customLevels = {
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    arb: 3,
    debug: 4,
  },
  colors: {
    error: "red",
    warn: "yellow",
    info: "white",
    arb: "green",
    debug: "blue",
  },
};

// Add custom colors
winston.addColors(customLevels.colors);

const logFormat = printf((info) => {
  const { timestamp, level, message } = info;
  return `${timestamp} [${level}]: ${message}`;
});

export const logger = winston.createLogger({
  levels: customLevels.levels,
  level: "debug",
  format: combine(timestamp(), colorize({ all: true }), logFormat),
  transports: [
    new winston.transports.Console({
      format: combine(timestamp(), colorize({ all: true }), logFormat),
    }),
  ],
});

// Convenience methods
export const logArb = (message: string) => logger.log("arb", message);
export const logError = (message: string, error?: any) => {
  if (error) {
    logger.error(message, { error: error.message || error });
  } else {
    logger.error(message);
  }
};
export const logInfo = (message: string) => logger.info(message);
export const logDebug = (message: string) => logger.debug(message);
export const logWarn = (message: string) => logger.warn(message);
