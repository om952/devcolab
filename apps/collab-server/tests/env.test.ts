import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/lib/env";

const BASE = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  JWT_SECRET: "a-sufficiently-long-dev-secret",
  CORS_ORIGIN: "https://app.example.com",
  INTERNAL_API_KEY: "x".repeat(32),
};

function messagesFor(result: ReturnType<typeof parseEnv>, path: string) {
  if (result.success) return [];
  return result.error.issues.filter((i) => i.path.join(".") === path).map((i) => i.message);
}

describe("env validation", () => {
  describe("auth rate limit", () => {
    it("defaults to 20 attempts per 15 minutes", () => {
      const result = parseEnv({ ...BASE } as any);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.AUTH_RATE_LIMIT_MAX).toBe(20);
      expect(result.data.AUTH_RATE_LIMIT_WINDOW_MS).toBe(15 * 60 * 1000);
    });

    it("accepts an override for deployments that need more headroom", () => {
      const result = parseEnv({ ...BASE, AUTH_RATE_LIMIT_MAX: "1000" } as any);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.AUTH_RATE_LIMIT_MAX).toBe(1000);
    });

    it("refuses a limit of zero, which would lock everyone out", () => {
      const result = parseEnv({ ...BASE, AUTH_RATE_LIMIT_MAX: "0" } as any);
      expect(result.success).toBe(false);
    });
  });

  it("accepts a minimal valid development config", () => {
    const result = parseEnv({ ...BASE, CORS_ORIGIN: "http://localhost:3000" } as any);
    expect(result.success).toBe(true);
  });

  it("requires DATABASE_URL", () => {
    const { DATABASE_URL, ...rest } = BASE;
    expect(parseEnv(rest as any).success).toBe(false);
  });

  it("rejects a JWT_SECRET shorter than 16 characters", () => {
    const result = parseEnv({ ...BASE, JWT_SECRET: "short" } as any);
    expect(messagesFor(result, "JWT_SECRET")[0]).toMatch(/at least 16/);
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    const result = parseEnv({ ...BASE, DATABASE_URL: "mysql://u:p@localhost:3306/db" } as any);
    expect(result.success).toBe(false);
  });

  it("parses CORS_ORIGIN into a list and strips trailing slashes", () => {
    const result = parseEnv({
      ...BASE,
      CORS_ORIGIN: "https://a.example.com/, https://b.example.com",
    } as any);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.CORS_ORIGIN).toEqual(["https://a.example.com", "https://b.example.com"]);
    }
  });

  describe("production hardening", () => {
    const PROD = { ...BASE, NODE_ENV: "production" };

    it("refuses a known default JWT_SECRET", () => {
      const result = parseEnv({
        ...PROD,
        JWT_SECRET: "devcolab-jwt-secret-change-in-production",
      } as any);
      expect(messagesFor(result, "JWT_SECRET")[0]).toMatch(/well-known default/);
    });

    it("requires INTERNAL_API_KEY", () => {
      const { INTERNAL_API_KEY, ...rest } = PROD;
      const result = parseEnv(rest as any);
      expect(messagesFor(result, "INTERNAL_API_KEY").length).toBeGreaterThan(0);
    });

    it("refuses a localhost CORS origin", () => {
      const result = parseEnv({ ...PROD, CORS_ORIGIN: "http://localhost:3000" } as any);
      expect(messagesFor(result, "CORS_ORIGIN")[0]).toMatch(/localhost/);
    });

    it("refuses to skip LLM key checks", () => {
      const result = parseEnv({ ...PROD, LLM_KEY_CHECK: "skip" } as any);
      expect(messagesFor(result, "LLM_KEY_CHECK")[0]).toMatch(/production/);
    });

    it("accepts a fully valid production config", () => {
      expect(parseEnv(PROD as any).success).toBe(true);
    });

    it("allows the weak secret outside production", () => {
      const result = parseEnv({
        ...BASE,
        NODE_ENV: "development",
        JWT_SECRET: "devcolab-jwt-secret-change-in-production",
      } as any);
      expect(result.success).toBe(true);
    });
  });

  it("defaults TRUST_PROXY to 0 so X-Forwarded-For cannot be spoofed", () => {
    const result = parseEnv(BASE as any);
    if (result.success) expect(result.data.TRUST_PROXY).toBe(0);
  });

  describe("blank values in a .env file", () => {
    // `.env` files write "unset" as `KEY=`, which dotenv turns into "".
    // Treating that as a set-but-invalid value would make a verbatim copy of
    // .env.example fail to boot.
    it("treats blank optional values as unset", () => {
      const result = parseEnv({
        ...BASE,
        INTERNAL_API_KEY: "",
        SENTRY_DSN: "",
        REDIS_URL: "",
        LOG_LEVEL: "",
      } as any);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SENTRY_DSN).toBeUndefined();
        expect(result.data.REDIS_URL).toBeUndefined();
        expect(result.data.LOG_LEVEL).toBeUndefined();
      }
    });

    it("falls back to defaults for blank values that have one", () => {
      const result = parseEnv({ ...BASE, JSON_BODY_LIMIT: "", AI_REVIEW_CONCURRENCY: "" } as any);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.JSON_BODY_LIMIT).toBe("2mb");
        expect(result.data.AI_REVIEW_CONCURRENCY).toBe(3);
      }
    });

    it("still rejects a blank required value", () => {
      const result = parseEnv({ ...BASE, JWT_SECRET: "" } as any);
      expect(result.success).toBe(false);
    });
  });
});
