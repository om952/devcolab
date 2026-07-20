import { PrismaClient } from "@prisma/client";

declare const global: { prisma?: PrismaClient };

const globalForPrisma = global;

export const prisma = globalForPrisma.prisma || new PrismaClient();

// @ts-ignore
if (typeof process !== "undefined" && process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export * from "@prisma/client";