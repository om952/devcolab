import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { prisma } from "@devcolab/database";
import { env } from "./env";

const JWT_SECRET = env.JWT_SECRET;
const JWT_EXPIRES_IN = env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"];

/** Name of the httpOnly cookie the browser holds its session token in. */
export const SESSION_COOKIE = "devcolab_session";

export interface TokenClaims {
  userId: string;
  role: string;
  /** The user's tokenVersion when this token was issued. */
  tv: number;
}

function issueToken(userId: string, role: string, tokenVersion: number): string {
  const claims: TokenClaims = { userId, role, tv: tokenVersion };
  return jwt.sign(claims, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
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

  const token = issueToken(user.id, user.role, user.tokenVersion);
  return { user: { id: user.id, email: user.email, name: user.name, role: user.role }, token };
}

export async function loginUser(data: LoginInput) {
  const user = await prisma.user.findUnique({ where: { email: data.email } });
  if (!user) throw new Error("Invalid credentials");

  const valid = await bcrypt.compare(data.password, user.password);
  if (!valid) throw new Error("Invalid credentials");

  const token = issueToken(user.id, user.role, user.tokenVersion);
  return { user: { id: user.id, email: user.email, name: user.name, role: user.role }, token };
}

export function verifyToken(token: string): TokenClaims {
  return jwt.verify(token, JWT_SECRET) as TokenClaims;
}

/**
 * Who a token belongs to, or null if it is invalid, expired, revoked, or for a
 * deleted account.
 *
 * Checks the database on every call: a signature alone cannot say whether the
 * user has since logged out, and this is what makes logout take effect
 * immediately rather than whenever the token expires.
 */
export async function resolveToken(
  token: string
): Promise<{ userId: string; role: string; name: string } | null> {
  let claims: TokenClaims;
  try {
    claims = verifyToken(token);
  } catch {
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { id: claims.userId },
    select: { id: true, role: true, name: true, tokenVersion: true },
  });
  // Tokens from before versioning carry no `tv` and are rejected with the rest.
  if (!user || claims.tv !== user.tokenVersion) return null;

  return { userId: user.id, role: user.role, name: user.name };
}

/** Invalidate every token issued to this user so far. */
export async function revokeTokens(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { tokenVersion: { increment: 1 } },
  });
}

/** Read one cookie from a raw Cookie header, without pulling in a parser. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}
