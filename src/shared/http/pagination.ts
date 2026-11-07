/**
 * Cursor pagination shared by list endpoints.
 *
 * Clients opt in with `?limit=` (and `?cursor=` for the next page). Without `limit` the full
 * list is returned, so existing clients keep working. Either way the response carries
 * `meta: { total, nextCursor }` next to `data`.
 */

import { z } from "zod";

/** Largest page a client may ask for. */
export const MAX_PAGE_SIZE = 100;

/** Query fields for paginated lists. `cursor` is the `nextCursor` of the previous page. */
export const paginationQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
    cursor: z.string().trim().min(1).optional(),
});

/** Validated pagination query. */
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** One page of a list plus what the client needs to ask for the next one. */
export type Page<T> = {
    items: T[];
    /** Rows matching the filters across all pages. */
    total: number;
    /** Pass as `cursor` to get the next page; `null` on the last page. */
    nextCursor: string | null;
};

/**
 * Prisma arguments for one page, fetching one extra row to learn whether another page exists.
 *
 * @param query - The client's `limit` and `cursor`
 * @returns Spread into `findMany`; empty when no `limit` was given
 */
export function pageArgs(query: PaginationQuery) {
    if (!query.limit) {
        return {};
    }

    return {
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    };
}

/**
 * Trims the extra row fetched by {@link pageArgs} and works out the next cursor.
 *
 * @param rows - Rows returned by `findMany`
 * @param total - Count of rows matching the filters
 * @param query - The client's `limit` and `cursor`
 */
export function toPage<T extends { id: string }>(
    rows: T[],
    total: number,
    query: PaginationQuery,
): Page<T> {
    if (!query.limit || rows.length <= query.limit) {
        return { items: rows, total, nextCursor: null };
    }

    const items = rows.slice(0, query.limit);
    return { items, total, nextCursor: items[items.length - 1].id };
}
