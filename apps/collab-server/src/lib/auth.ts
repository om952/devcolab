import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { prisma } from "@devcolab/database";
import { env } from "./env";

const JWT_SECRET = env.JWT_SECRET;
const JWT_EXPIRES_IN = env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"];

function issueToken(userId: string, role: string): string {
  return jwt.sign({ userId, role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

/**
 * Deliberately has no `role` field. Accepting one let anyone register as an
 * author — or as `ai_reviewer`, the role reserved for the system account that
 * authors AI comments — which made the whole role boundary self-service.
 *
 * Everyone registers as a reviewer. What you may do inside a session comes
 * from owning it, not from a role you picked at signup; see requireSessionRole.
 */
export const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2, "Name must be at least 2 characters"),
  // Login deliberately keeps its lower bound: accounts created under the old
  // 6-character rule must still be able to sign in.
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;

export async function registerUser(data: RegisterInput) {
  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing) throw new Error("User already exists");

  const hashedPassword = await bcrypt.hash(data.password, 10);
  const user = await prisma.user.create({
    data: {
      email: data.email,
      name: data.name,
      password: hashedPassword,
      // Never client-controlled. ai_reviewer is assigned only by lib/ai-user.
      role: "reviewer",
    },
  });

  const token = issueToken(user.id, user.role);
  return { user: { id: user.id, email: user.email, name: user.name, role: user.role }, token };
}

export async function loginUser(data: LoginInput) {
  const user = await prisma.user.findUnique({ where: { email: data.email } });
  if (!user) throw new Error("Invalid credentials");

  const valid = await bcrypt.compare(data.password, user.password);
  if (!valid) throw new Error("Invalid credentials");

  const token = issueToken(user.id, user.role);
  return { user: { id: user.id, email: user.email, name: user.name, role: user.role }, token };
}

export function verifyToken(token: string): { userId: string; role: string } {
  return jwt.verify(token, JWT_SECRET) as { userId: string; role: string };
}
