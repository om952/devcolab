import { Router } from "express";
import { ZodError } from "zod";
import { loginAccountLimiter } from "../lib/rate-limit";
import { clearCredential } from "../lib/llm-credentials";
import { prisma } from "@devcolab/database";
import jwt from "jsonwebtoken";
import type { Response } from "express";
import type { Server } from "socket.io";
import {
  registerUser,
  loginUser,
  registerSchema,
  loginSchema,
  revokeTokens,
  resolveToken,
  SESSION_COOKIE,
} from "../lib/auth";
import {
  authenticate,
  asyncHandler,
  sessionCookieOptions,
  tokenFromRequest,
  type AuthRequest,
} from "../lib/middleware";

const router = Router();

/**
 * Hand the token to the browser as an httpOnly cookie that lives exactly as
 * long as the token itself. It is deliberately not in the response body:
 * anything page scripts can read, an injected script can steal.
 */
function setSessionCookie(res: Response, token: string) {
  const exp = (jwt.decode(token) as { exp?: number } | null)?.exp;
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions(exp ? exp * 1000 - Date.now() : undefined));
}

/** A ZodError's own message is a JSON dump of every issue; show the first one. */
function authErrorMessage(err: unknown): string {
  if (err instanceof ZodError) return err.issues[0]?.message ?? "Invalid input";
  return err instanceof Error ? err.message : "Something went wrong";
}

router.post("/register", async (req, res) => {
  try {
    const data = registerSchema.parse(req.body);
    const { user, token } = await registerUser(data);
    setSessionCookie(res, token);
    res.status(201).json({ user });
  } catch (err: any) {
    res.status(400).json({ error: authErrorMessage(err) });
  }
});

router.post("/login", loginAccountLimiter, async (req, res) => {
  try {
    const data = loginSchema.parse(req.body);
    const { user, token } = await loginUser(data);
    setSessionCookie(res, token);
    res.json({ user });
  } catch (err: any) {
    res.status(400).json({ error: authErrorMessage(err) });
  }
});

/**
 * Sign out everywhere: revoke every token this user holds, drop their live
 * sockets, and clear the cookie.
 *
 * Does not require a valid token, so a browser holding a dead cookie can still
 * be told to forget it.
 */
router.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const { token } = tokenFromRequest(req);
    const identity = token ? await resolveToken(token) : null;

    if (identity) {
      await revokeTokens(identity.userId);
      clearCredential(identity.userId);
      const io = req.app.get("io") as Server | undefined;
      io?.in(`user:${identity.userId}`).disconnectSockets(true);
    }

    res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
    res.status(204).send();
  })
);

/**
 * Who is this token? The client stores its session in localStorage, which says
 * nothing about whether the token is still valid — an expired or revoked one
 * looks identical to a good one until a request fails. Calling this on load
 * turns that into an explicit answer.
 *
 * The role comes from the database rather than the token claim, so a role
 * changed after the token was issued takes effect on the next load instead of
 * persisting for the remainder of the token's 7-day life.
 */
router.get(
  "/me",
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { id: true, email: true, name: true, role: true },
    });

    // Correctly signed token for an account that no longer exists.
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    res.json(user);
  })
);

export default router;
