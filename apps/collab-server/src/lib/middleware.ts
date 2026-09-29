import { Request, Response, NextFunction, CookieOptions } from "express";
import { SESSION_COOKIE, readCookie, resolveToken } from "./auth";
import { env } from "./env";

export interface AuthRequest extends Request {
  user?: { userId: string; role: string };
  /** Set by requireSessionRole: the caller's role in the session being acted on. */
  sessionRole?: "author" | "reviewer" | "ai_reviewer";
}

/**
 * The browser authenticates with an httpOnly cookie, so page scripts never see
 * the token. SameSite=Strict keeps other sites from making requests that carry
 * it, which is what stands in for CSRF tokens here: the web app proxies the
 * API onto its own origin, so every legitimate request is same-site.
 *
 * Secure only in production, so plain-http local development still works.
 */
export function sessionCookieOptions(maxAgeMs?: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: env.NODE_ENV === "production",
    path: "/",
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
  };
}

/** Cookie first (browsers), then a Bearer header (scripts, tests, other clients). */
export function tokenFromRequest(req: Request): { token: string | null; fromCookie: boolean } {
  const cookie = readCookie(req.headers.cookie, SESSION_COOKIE);
  if (cookie) return { token: cookie, fromCookie: true };

  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return { token: header.slice("Bearer ".length), fromCookie: false };

  return { token: null, fromCookie: false };
}

export function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const { token, fromCookie } = tokenFromRequest(req);
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  resolveToken(token)
    .then((identity) => {
      if (!identity) {
        // A dead cookie would otherwise be resent on every request.
        if (fromCookie) res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
        res.status(401).json({ error: "Invalid token" });
        return;
      }
      req.user = { userId: identity.userId, role: identity.role };
      next();
    })
    .catch(next);
}

/**
 * Wrap an async route handler so a rejected promise reaches Express.
 *
 * Express 4 does not await handlers, so a rejection from an `async` route is
 * never caught: the handler stops, no response is ever sent, and the client
 * hangs until it gives up. That surfaced as a 15s hang on GET /api/sessions/:id
 * when a concurrent participant insert lost a unique-constraint race.
 *
 * Passing the error to next() hands it to the global error handler, which
 * returns 500 and logs it. Remove when upgrading to Express 5, which awaits
 * handlers natively.
 */
export function asyncHandler<R extends Request = AuthRequest>(
  handler: (req: R, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req as R, res, next)).catch(next);
  };
}
