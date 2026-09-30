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
  // Request logging records headers. None of these may reach a log line: the
  // session cookie, bearer tokens, the service key, or a user's own LLM key.
  redact: {
    paths: [
      "req.headers.cookie",
      "req.headers.authorization",
      'req.headers["x-internal-api-key"]',
      'req.headers["x-llm-api-key"]',
      'res.headers["set-cookie"]',
    ],
    censor: "[redacted]",
  },
});

export default logger;
