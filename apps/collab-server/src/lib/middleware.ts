import { Request, Response, NextFunction } from "express";
import { verifyToken } from "./auth";

export interface AuthRequest extends Request {
  user?: { userId: string; role: string };
}

export function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const token = authHeader.split(" ")[1];
    const payload = verifyToken(token);
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

export function authorize(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
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
