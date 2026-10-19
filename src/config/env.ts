/**
 * Validated environment configuration.
 *
 * This is the only module that reads `process.env`. Everything else imports `env`
 * from here, so a missing or malformed variable fails fast at boot with a clear
 * message instead of surfacing later as a confusing runtime error.
 *
 * Optional integrations (Mem0, Tavily, Firecrawl, Cloudinary, Google OAuth) may be
 * left unset; the features that depend on them degrade gracefully.
 */

import "dotenv/config";
import { z } from "zod";

/** Treats empty or whitespace-only values (e.g. `FOO=` in .env) as unset. */
const optional = <T extends z.ZodType>(schema: T) =>
    z.preprocess(
        (value) =>
            typeof value === "string" && value.trim() === "" ? undefined : value,
        schema.optional(),
    );

const optionalString = optional(z.string().trim());

const envSchema = z
    .object({
        NODE_ENV: z
            .enum(["development", "test", "production"])
            .default("development"),
        PORT: z.coerce.number().int().positive().default(8080),
        CLIENT_URL: z.url().default("http://localhost:3000"),

        DATABASE_URL: z.url(),

        BETTER_AUTH_SECRET: z.string().trim().min(1),
        BETTER_AUTH_URL: optional(z.url()),
        GOOGLE_CLIENT_ID: optionalString,
        GOOGLE_CLIENT_SECRET: optionalString,

        OPENAI_API_KEY: z.string().trim().min(1),

        PINECONE_API_KEY: z.string().trim().min(1),
        PINECONE_INDEX: z.string().trim().min(1).default("grounded-brain-notebook-llm"),

        INNGEST_DEV: optional(z.enum(["0", "1", "true", "false"])),
        INNGEST_EVENT_KEY: optionalString,
        INNGEST_SIGNING_KEY: optionalString,

        CLOUDINARY_CLOUD_NAME: optionalString,
        CLOUDINARY_UPLOAD_PRESET: optionalString,
        CLOUDINARY_API_KEY: optionalString,
        CLOUDINARY_API_SECRET: optionalString,

        FIRECRAWL_API_KEY: optionalString,
        TAVILY_API_KEY: optionalString,
        MEM0_API_KEY: optionalString,
    })
    .superRefine((value, ctx) => {
        const requireTogether = (keys: (keyof typeof value)[], reason: string) => {
            const set = keys.filter((key) => value[key] !== undefined);
            if (set.length > 0 && set.length < keys.length) {
                for (const key of keys.filter((key) => value[key] === undefined)) {
                    ctx.addIssue({
                        code: "custom",
                        path: [key],
                        message: `Required when ${set.join(", ")} is set (${reason})`,
                    });
                }
            }
        };

        requireTogether(
            ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
            "Google OAuth",
        );
        requireTogether(
            ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_UPLOAD_PRESET"],
            "PDF uploads",
        );
        requireTogether(
            ["CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"],
            "signed Cloudinary downloads",
        );

        const inngestDev =
            value.INNGEST_DEV === "1" || value.INNGEST_DEV === "true";

        if (value.NODE_ENV === "production" && !inngestDev) {
            for (const key of ["INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY"] as const) {
                if (!value[key]) {
                    ctx.addIssue({
                        code: "custom",
                        path: [key],
                        message:
                            "Required in production so the /api/inngest endpoint is authenticated",
                    });
                }
            }
        }
    });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    console.error(
        `Invalid environment configuration:\n${z.prettifyError(parsed.error)}`,
    );
    process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === "production";

/** `true`/`false` when `INNGEST_DEV` is set, otherwise `undefined` (Inngest decides). */
export const inngestDevMode =
    env.INNGEST_DEV === undefined
        ? undefined
        : env.INNGEST_DEV === "1" || env.INNGEST_DEV === "true";
