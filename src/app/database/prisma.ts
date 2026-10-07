import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "../../generated/prisma/client.js";
import { getPostgresEnv } from "../config/env";

// Sole Prisma client owner. Importing this module does not connect and does
// not require NEON_DB_URL. getPrismaClient() is the first call that does.

let client: PrismaClient | undefined;

export function getPrismaClient(): PrismaClient {
  if (client) return client;
  const adapter = new PrismaNeon({ connectionString: getPostgresEnv().databaseUrl });
  client = new PrismaClient({ adapter });
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (!client) return;
  await client.$disconnect();
  client = undefined;
}

export async function checkPostgresHealth(prisma: PrismaClient = getPrismaClient()): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}
