import { z } from "zod";

/** Route params containing `:memoryId`. */
export const memoryIdParamSchema = z.object({
    memoryId: z.string().trim().min(1),
});

/** Body for creating a memory: non-empty text up to 2000 characters. */
export const createMemorySchema = z.object({
    memory: z.string().trim().min(1).max(2000),
});

/** Body for updating a memory: non-empty text up to 2000 characters. */
export const updateMemorySchema = z.object({
    memory: z.string().trim().min(1).max(2000),
});
