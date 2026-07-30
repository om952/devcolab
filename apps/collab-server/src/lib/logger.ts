import pino from "pino";
import { env } from "./env";

const defaultLevel =
  env.NODE_ENV === "production" ? "info" : env.NODE_ENV === "test" ? "silent" : "debug";

export const logger = pino({
  level: env.LOG_LEVEL ?? defaultLevel,
  transport:
    env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } }
      : undefined,
  base: { service: "collab-server" },
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: pino.stdSerializers,
});

export default logger;
