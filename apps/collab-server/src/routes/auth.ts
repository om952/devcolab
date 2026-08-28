import { Router } from "express";
import { prisma } from "@devcolab/database";
import { registerUser, loginUser, registerSchema, loginSchema } from "../lib/auth";
import { authenticate, asyncHandler, type AuthRequest } from "../lib/middleware";

const router = Router();

router.post("/register", async (req, res) => {
  try {
    const data = registerSchema.parse(req.body);
    const result = await registerUser(data);
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/login", async (req, res) => {
  try {
    const data = loginSchema.parse(req.body);
    const result = await loginUser(data);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

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
