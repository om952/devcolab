import { z } from "zod";

/**
 * Secrets that ship in .env.example / docker-compose defaults. Allowed while
 * developing, but a hard boot failure in production.
 */
const WEAK_JWT_SECRETS = new Set([
  "devcolab-jwt-secret-change-in-production",
  "changeme",
  "change-me",
  "secret",
  "your-secret-key",
  "supersecret",
]);

const originList = z
  .string()
  .default("http://localhost:3000")
  .transform((value) =>
    value
      .split(",")
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter(Boolean)
  )
  .pipe(z.array(z.string().url()).min(1, "CORS_ORIGIN must contain at least one valid URL"));

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().default(4000),
    DATABASE_URL: z.string().url().startsWith("postgresql://"),
    JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
    JWT_EXPIRES_IN: z.string().default("7d"),
    CORS_ORIGIN: originList,
    AI_SERVICE_URL: z.string().url().default("http://localhost:8000"),
    INTERNAL_API_KEY: z
      .string()
      .min(16, "INTERNAL_API_KEY must be at least 16 characters")
      .optional(),
    SENTRY_DSN: z.string().url().optional(),
    REDIS_URL: z.string().url().optional(),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),
    // Hardening knobs
    // Number of proxy hops to trust for client IPs. Keep at 0 unless running
    // behind a load balancer — over-trusting lets clients spoof X-Forwarded-For
    // and bypass IP rate limits.
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    JSON_BODY_LIMIT: z.string().default("2mb"),
    // Brute-force budget for login/register, per IP. Tunable because the right
    // value is deployment-specific — a shared corporate egress IP needs more
    // headroom than a public signup page, and an end-to-end test suite that
    // registers a fresh user per case needs far more than either.
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
    AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(15 * 60 * 1000),
    // Failed logins allowed per account (email) per window, whatever address
    // they come from. Deliberately separate from the per-IP limit above: behind
    // Render's proxies the client address cannot be identified exactly, so
    // per-IP alone cannot stop someone guessing one account's password.
    AUTH_ACCOUNT_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
    MAX_CODE_FILE_BYTES: z.coerce.number().default(512 * 1024),
    // Must exceed ai-service's per-agent timeout (AGENT_TIMEOUT_SECONDS,
    // default 90s). Set below it and this side aborts the stream mid-run and
    // falls back to the heuristic scanner while the agents are still working.
    AI_REVIEW_TIMEOUT_MS: z.coerce.number().default(180_000),
    // How many reviews one instance runs at once, and how many times a failed
    // job is retried before it is left as failed.
    AI_REVIEW_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(3),
    AI_REVIEW_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(2),
    // Reviews one user may start in any rolling 24 hours. Each review is four
    // LLM calls, so this bounds what one account can spend on the provider quota.
    AI_REVIEW_DAILY_LIMIT: z.coerce.number().int().min(1).default(50),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== "production") return;

    if (WEAK_JWT_SECRETS.has(value.JWT_SECRET)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["JWT_SECRET"],
        message: "refusing to boot in production with a well-known default secret",
      });
    }

    if (!value.INTERNAL_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["INTERNAL_API_KEY"],
        message: "required in production so ai-service can reject unauthenticated callers",
      });
    }

    if (value.CORS_ORIGIN.some((origin) => origin.includes("localhost"))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CORS_ORIGIN"],
        message: "must not point at localhost in production",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export { envSchema };

/** Pure parse, exported so the rules can be tested without exiting the process. */
export function parseEnv(raw: NodeJS.ProcessEnv): z.SafeParseReturnType<unknown, Env> {
  // `.env` files spell "unset" as `KEY=`, which dotenv turns into an empty
  // string. Without this, copying .env.example verbatim fails validation on
  // every blank optional value instead of falling back to defaults.
  const cleaned = Object.fromEntries(
    Object.entries(raw).filter(([, value]) => value !== "")
  );
  return envSchema.safeParse(cleaned);
}

function validateEnv(): Env {
  const result = parseEnv(process.env);

  if (!result.success) {
    console.error("❌ Invalid environment variables:");
    for (const issue of result.error.issues) {
      console.error(`   ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }

  return result.data;
}

export const env = validateEnv();
