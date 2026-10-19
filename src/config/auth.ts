/**
 * Better Auth server configuration.
 *
 * Handles Google OAuth and session persistence via Prisma/PostgreSQL.
 * The client authenticates against routes mounted from this `auth` instance.
 *
 * Required env vars: `BETTER_AUTH_SECRET`
 * Optional: `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` (Google login), `BETTER_AUTH_URL`, `CLIENT_URL`
 */

import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { env, isProduction } from "./env.js";
import prisma from "./db.js";

/**
 * Configured Better Auth instance shared by Express route handlers.
 *
 */
export const auth = betterAuth({
    baseURL: env.BETTER_AUTH_URL ?? env.CLIENT_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.CLIENT_URL],
    database: prismaAdapter(prisma, {
        provider: "postgresql",
    }),

    // Google OAuth configuration (env validation guarantees both or neither are set)
    socialProviders:
        env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
            ? {
                  google: {
                      clientId: env.GOOGLE_CLIENT_ID,
                      clientSecret: env.GOOGLE_CLIENT_SECRET,
                      // Optional: restrict to your domain
                      // prompt: "select_account",
                  },
              }
            : {},
    emailAndPassword: {
        // Dev/testing convenience. Turned OFF when NODE_ENV=production.
        enabled: !isProduction,
    },
});
