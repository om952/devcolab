import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { asyncHandler } from "../src/lib/middleware";

/**
 * Express 4 does not await route handlers, so a rejected promise from an
 * `async` route never reaches the error handler: the handler stops, no
 * response is written, and the client hangs until it gives up. This wrapper is
 * what turns that hang into an ordinary 500.
 */
describe("asyncHandler", () => {
  function appWith(handler: express.RequestHandler) {
    const app = express();
    app.get("/probe", handler);
    app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: "Internal server error" });
    });
    return app;
  }

  it("turns a rejected handler into a 500 rather than a hung request", async () => {
    const app = appWith(
      asyncHandler(async () => {
        throw new Error("boom");
      })
    );

    const res = await request(app).get("/probe");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
  });

  it("passes a rejection to the error handler, not the response", async () => {
    const app = appWith(
      asyncHandler(async () => {
        await Promise.reject(new Error("async boom"));
      })
    );

    const res = await request(app).get("/probe");
    expect(res.status).toBe(500);
  });

  it("leaves a successful handler's response untouched", async () => {
    const app = appWith(
      asyncHandler(async (_req, res) => {
        res.json({ ok: true });
      })
    );

    const res = await request(app).get("/probe");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
