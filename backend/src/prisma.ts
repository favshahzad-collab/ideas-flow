import "dotenv/config";
import { PrismaClient } from "./generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// This app is a single long-running Express process, not a serverless/edge
// deployment, so a direct connection with Prisma's own small pool avoids the
// pgbouncer transaction-mode hop (and enables prepared-statement caching).
// Falls back to DATABASE_URL (pgbouncer) if DIRECT_URL isn't configured.
const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "Neither DIRECT_URL nor DATABASE_URL environment variable is set"
  );
}

const adapter = new PrismaPg({
  connectionString,
  max: 10,
});

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
