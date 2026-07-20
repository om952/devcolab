import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { prisma } from "@devcolab/database";

const JWT_SECRET = process.env.JWT_SECRET || "devcolab-jwt-secret";

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2),
  password: z.string().min(6),
  role: z.enum(["author", "reviewer", "ai_reviewer"]).optional(),
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
      role: data.role || "reviewer",
    },
  });

  const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: "7d" });
  return { user: { id: user.id, email: user.email, name: user.name, role: user.role }, token };
}

export async function loginUser(data: LoginInput) {
  const user = await prisma.user.findUnique({ where: { email: data.email } });
  if (!user) throw new Error("Invalid credentials");

  const valid = await bcrypt.compare(data.password, user.password);
  if (!valid) throw new Error("Invalid credentials");

  const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: "7d" });
  return { user: { id: user.id, email: user.email, name: user.name, role: user.role }, token };
}

export function verifyToken(token: string): { userId: string; role: string } {
  return jwt.verify(token, JWT_SECRET) as { userId: string; role: string };
}
