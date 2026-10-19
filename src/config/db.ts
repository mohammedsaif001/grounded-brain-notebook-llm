/**
 * Prisma Client singleton with PostgreSQL driver adapter.
 *
 * Reuses one client in development (via `globalThis`) to survive hot reloads.
 * Requires `DATABASE_URL` in the environment.
 *
 */

import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { env, isProduction } from "./env.js";

const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClient | undefined;
};

const prisma =
    globalForPrisma.prisma ??
    new PrismaClient({
        adapter: new PrismaPg(
            new Pool({
                connectionString: env.DATABASE_URL,
            }),
        ),
    });

if (!isProduction) {
    globalForPrisma.prisma = prisma;
}

export default prisma;
