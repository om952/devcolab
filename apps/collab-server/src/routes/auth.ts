import { Router } from "express";
import { registerUser, loginUser, registerSchema, loginSchema } from "../lib/auth";

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

export default router;
