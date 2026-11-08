/**
 * End-to-end smoke test for the whole API, run against a live server.
 *
 * Talks to the server over HTTP like a real client (cookie auth, JSON envelope, streamed
 * chat), creates its own users and data, checks every feature, then cleans up.
 *
 * Prerequisites: Postgres up, `npm run dev` (or `npm start`) and `npx inngest-cli@latest dev`
 * running. Usage:
 *
 *   npm run smoke                 # core + AI flows (sources indexed, chat, artifacts)
 *   npm run smoke -- --no-ai      # skip anything that calls OpenAI (fast, free)
 *   npm run smoke -- --external   # also PDF upload, website, YouTube, GitHub repo, web search
 *   npm run smoke -- --keep       # leave the created workspaces in place for inspection
 *
 * Env: SMOKE_BASE_URL (default http://localhost:8080), SMOKE_ORIGIN (default
 * http://localhost:3000, must match the server's CLIENT_URL).
 */

/** Server under test. */
const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://localhost:8080";
/** Sent as the `Origin` header so CORS and Better Auth accept the requests. */
const ORIGIN = process.env.SMOKE_ORIGIN ?? "http://localhost:3000";

/** CLI flags, e.g. `--no-ai`, `--external`, `--keep`. */
const args = new Set(process.argv.slice(2));
/** Run flows that call OpenAI (disabled by `--no-ai`). */
const AI = !args.has("--no-ai");
/** Also exercise PDF upload, website, YouTube, GitHub repo and web search imports (`--external`). */
const EXTERNAL = args.has("--external");
/** Leave created workspaces in place for inspection (`--keep`). */
const KEEP = args.has("--keep");

/** Delay between status polls. Each poll is a request, and the API allows 300 per 15 minutes per IP. */
const POLL_INTERVAL_MS = 3_000;

/** Requests sent by this run; reported at the end because the API rate limit is 300 per 15 minutes per IP. */
let requestCount = 0;
/** How long to wait for a source to finish indexing. */
const SOURCE_TIMEOUT_MS = 90_000;
/** How long to wait for an artifact to finish generating. */
const ARTIFACT_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// HTTP client with a cookie jar (Better Auth sessions are cookie-based)
// ---------------------------------------------------------------------------

/** A response from the API, with the JSON envelope pre-parsed. */
type ApiResponse = {
    status: number;
    headers: Headers;
    /** Parsed JSON body (the `{ success, data | error }` envelope), or null. */
    body: {
        success?: boolean;
        data?: any;
        /** Present on paginated lists: `{ total, nextCursor }`. */
        meta?: any;
        error?: { code: string; message: string; details?: any };
    } | null;
    text: string;
};

/** HTTP client for one signed-in user; keeps cookies between requests. */
class Client {
    /** Cookies set by the server (session), replayed on every request. */
    private cookies = new Map<string, string>();

    /** @param label - Name used in logs, e.g. `A` or `B` */
    constructor(readonly label: string) {}

    /**
     * Sends a request and stores any cookies the server sets.
     *
     * @param method - HTTP method
     * @param path - Path beginning with `/`, appended to {@link BASE_URL}
     * @param options.json - Body sent as JSON
     * @param options.form - Multipart body (used for PDF upload)
     * @returns Status, headers, parsed JSON (or `null`) and raw text
     */
    async request(
        method: string,
        path: string,
        options: { json?: unknown; form?: FormData } = {},
    ): Promise<ApiResponse> {
        const headers: Record<string, string> = { Origin: ORIGIN };
        if (this.cookies.size > 0) {
            headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
        }

        let body: string | FormData | undefined;
        if (options.json !== undefined) {
            headers["Content-Type"] = "application/json";
            body = JSON.stringify(options.json);
        } else if (options.form) {
            body = options.form;
        }

        requestCount += 1;
        const res = await fetch(`${BASE_URL}${path}`, { method, headers, body });

        for (const cookie of res.headers.getSetCookie()) {
            const [pair] = cookie.split(";");
            const index = pair.indexOf("=");
            const name = pair.slice(0, index).trim();
            const value = pair.slice(index + 1).trim();
            if (value) this.cookies.set(name, value);
            else this.cookies.delete(name);
        }

        const text = await res.text();
        let parsed: ApiResponse["body"] = null;
        try {
            parsed = text ? (JSON.parse(text) as ApiResponse["body"]) : null;
        } catch {
            // Streamed or non-JSON response; callers use `text`.
        }

        return { status: res.status, headers: res.headers, body: parsed, text };
    }

    /** GET `path`. */
    get = (path: string) => this.request("GET", path);
    /** POST `path` with a JSON body (defaults to `{}`). */
    post = (path: string, json?: unknown) => this.request("POST", path, { json: json ?? {} });
    /** PATCH `path` with a JSON body. */
    patch = (path: string, json: unknown) => this.request("PATCH", path, { json });
    /** DELETE `path`. */
    delete = (path: string) => this.request("DELETE", path);
}

// ---------------------------------------------------------------------------
// Tiny test runner
// ---------------------------------------------------------------------------

/** Thrown inside a step to mark it skipped (e.g. an integration isn't configured). */
class Skip extends Error {}

/** Outcome of one step, collected for the final summary. */
type Result = {
    section: string;
    name: string;
    status: "PASS" | "FAIL" | "SKIP";
    ms: number;
    detail?: string;
};
/** Every step result so far. */
const results: Result[] = [];
/** Title of the section currently running (see {@link begin}). */
let section = "";

/**
 * Assertion helper.
 *
 * @param condition - Must be truthy
 * @param message - Failure message
 * @throws {Error} When `condition` is falsy
 */
function expect(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

/**
 * Asserts the HTTP status, including the API error code and message in the failure text.
 *
 * @param res - Response to check
 * @param expected - Expected HTTP status
 */
function expectStatus(res: ApiResponse, expected: number) {
    const error = res.body?.error ? ` ${res.body.error.code}: ${res.body.error.message}` : "";
    expect(res.status === expected, `expected ${expected}, got ${res.status}${error}`);
}

/**
 * Integrations that aren't configured return 503; treat that as a skip, not a failure.
 *
 * @param res - Response to inspect
 * @throws {Skip} When the status is 503
 */
function skipIfNotConfigured(res: ApiResponse) {
    if (res.status === 503) throw new Skip(res.body?.error?.message ?? "not configured");
}

/**
 * Runs one named check, records PASS / FAIL / SKIP and prints the result. Never throws.
 *
 * @param name - Description shown in the output
 * @param fn - The check; may return a short detail string
 */
async function step(name: string, fn: () => Promise<string | void>) {
    const started = Date.now();
    try {
        const detail = await fn();
        results.push({
            section,
            name,
            status: "PASS",
            ms: Date.now() - started,
            detail: detail ?? undefined,
        });
        console.log(`  \x1b[32m✔\x1b[0m ${name}${detail ? ` \x1b[2m(${detail})\x1b[0m` : ""}`);
    } catch (error) {
        const skipped = error instanceof Skip;
        const detail = error instanceof Error ? error.message : String(error);
        results.push({
            section,
            name,
            status: skipped ? "SKIP" : "FAIL",
            ms: Date.now() - started,
            detail,
        });
        console.log(
            skipped
                ? `  \x1b[33m-\x1b[0m ${name} \x1b[2m(skipped: ${detail})\x1b[0m`
                : `  \x1b[31m✘ ${name}\x1b[0m\n      ${detail}`,
        );
    }
}

/**
 * Starts a new output section.
 *
 * @param title - Section heading
 */
function begin(title: string) {
    section = title;
    console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/** Resolves after `ms` milliseconds. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Repeatedly fetches state until `isDone` is satisfied.
 *
 * @param fetchState - Loads the current state
 * @param isDone - Returns `true` once the state is final
 * @param timeoutMs - Give up after this long
 * @param timeoutHint - Troubleshooting hint added to the timeout error
 * @returns The final state
 * @throws {Error} When the timeout elapses
 */
async function poll<T>(
    fetchState: () => Promise<T>,
    isDone: (state: T) => boolean,
    timeoutMs: number,
    timeoutHint: string,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const state = await fetchState();
        if (isDone(state)) return state;
        if (Date.now() > deadline)
            throw new Error(`timed out after ${timeoutMs / 1000}s — ${timeoutHint}`);
        await sleep(POLL_INTERVAL_MS);
    }
}

/** Hint shown when a background job never finishes. */
const INNGEST_HINT = "is the Inngest dev server running (npx inngest-cli@latest dev)?";

/**
 * Waits for a source to be indexed and asserts that it ended `READY`.
 *
 * @param client - Signed-in client that owns the workspace
 * @param workspaceId - Workspace containing the source
 * @param sourceId - Source to wait for
 * @returns The READY source
 */
async function waitForSource(client: Client, workspaceId: string, sourceId: string) {
    const source = await poll(
        async () =>
            (await client.get(`/api/workspaces/${workspaceId}/sources/${sourceId}`)).body?.data,
        (s) => s?.status === "READY" || s?.status === "FAILED",
        SOURCE_TIMEOUT_MS,
        INNGEST_HINT,
    );
    expect(
        source.status === "READY",
        `source ended ${source.status}: ${JSON.stringify(source.metadata ?? {})}`,
    );
    return source;
}

/**
 * Reads the AI SDK UI message stream and returns the assistant's text.
 *
 * @param text - Raw `data: ...` server-sent-event body
 * @returns The concatenated text deltas
 * @throws {Error} When the stream contains an error chunk
 */
function readChatStream(text: string) {
    let reply = "";
    for (const line of text.split("\n")) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        const chunk = JSON.parse(line.slice(6)) as {
            type: string;
            delta?: string;
            errorText?: string;
        };
        if (chunk.type === "error") throw new Error(`stream error: ${chunk.errorText}`);
        if (chunk.type === "text-delta" && chunk.delta) reply += chunk.delta;
    }
    return reply;
}

/**
 * Asks one question in a fresh conversation and returns the reply with the citations it saved.
 *
 * @param client - Signed-in client that owns the workspace
 * @param workspaceId - Workspace to chat in
 * @param question - The user's question
 * @returns The reply text and the citations stored on the assistant message
 */
async function askChat(client: Client, workspaceId: string, question: string) {
    const base = `/api/workspaces/${workspaceId}`;
    const res = await client.post(`${base}/chat`, { messages: [userMessage(question)] });
    expectStatus(res, 200);
    const conversationId = res.headers.get("x-conversation-id") ?? "";
    const reply = readChatStream(res.text);

    const messages = (await client.get(`${base}/conversations/${conversationId}/messages`)).body
        ?.data as any[];
    const citations = messages
        .filter((m) => m.role === "ASSISTANT")
        .flatMap((m) => (m.citations as any[]) ?? []);
    return { reply, citations };
}

/** Question about the Atlantis fact; asks for a citation because the model may otherwise omit one. */
const ATLANTIS_QUESTION = "What is the capital of Atlantis? Cite the source marker in your answer.";

/**
 * Like {@link askChat}, retrying (up to 3 times) until `wanted` accepts the citations, because the
 * model does not always cite on the first try. Use only where a citation is the expected outcome.
 *
 * @param client - Signed-in client that owns the workspace
 * @param workspaceId - Workspace to chat in
 * @param question - The user's question
 * @param wanted - Returns `true` once the citations are what the test expects
 * @returns The last reply and its citations
 */
async function askUntilCited(
    client: Client,
    workspaceId: string,
    question: string,
    wanted: (citations: any[]) => boolean,
) {
    let answer = await askChat(client, workspaceId, question);
    for (let attempt = 1; attempt < 3 && !wanted(answer.citations); attempt += 1) {
        answer = await askChat(client, workspaceId, question);
    }
    return answer;
}

/** Builds a `useChat`-style user message with a single text part. */
const userMessage = (text: string) => ({
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }],
});

/**
 * Builds a minimal valid one-page PDF containing `text`.
 *
 * @param text - Text drawn on the page (must not contain unescaped parentheses)
 * @returns PDF bytes
 */
function buildPdf(text: string) {
    const content = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((body, i) => {
        offsets.push(pdf.length);
        pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf, "latin1");
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

/** Makes this run's users unique. */
const RUN_ID = Date.now();
/** Password for the throwaway test users. */
const PASSWORD = "Smoke-Test-Password-1!";
/** Primary test user; owns the workspace. */
const userA = { name: "Smoke A", email: `smoke-a-${RUN_ID}@test.local`, password: PASSWORD };
/** Second user, used to check that data isn't visible across accounts. */
const userB = { name: "Smoke B", email: `smoke-b-${RUN_ID}@test.local`, password: PASSWORD };

/** Plain-text fixture about photosynthesis. */
const TEXT_SOURCE = `Photosynthesis is the process plants use to turn light into chemical energy.
It happens in the chloroplasts, which contain the green pigment chlorophyll.

The light-dependent reactions take place in the thylakoid membranes and produce ATP and NADPH.
The Calvin cycle takes place in the stroma and uses ATP and NADPH to fix carbon dioxide into glucose.

Oxygen is released as a by-product when water molecules are split during the light reactions.`;

/** Markdown fixture about cellular respiration. */
const MARKDOWN_SOURCE = `# Cellular respiration

Cellular respiration converts glucose into ATP.

## Stages
- **Glycolysis** happens in the cytoplasm.
- The **Krebs cycle** happens in the mitochondrial matrix.
- The **electron transport chain** produces most of the ATP.`;

/** Fact used to prove that editing a source replaces what was indexed instead of adding to it. */
const ATLANTIS_V1 = `The capital of Atlantis is Poseidonia.
Poseidonia sits on a ring of canals at the centre of the island.`;

/** Same fact, changed. After an edit only this version may be retrievable. */
const ATLANTIS_V2 = `The capital of Atlantis is Meridia.
Meridia sits on a ring of canals at the centre of the island.`;

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

/** Client for {@link userA}. */
const a = new Client("A");
/** Client for {@link userB}. */
const b = new Client("B");
/** Ids shared between steps (workspace, source, conversation, ...). */
const state: Record<string, string> = {};
/** Path under the test workspace, e.g. `ws("/sources")`. */
const ws = (path = "") => `/api/workspaces/${state.workspaceId}${path}`;

/** Runs every smoke-test section in order, prints a summary and sets the exit code. */
async function main() {
    console.log(`Smoke test against ${BASE_URL} (ai: ${AI}, external: ${EXTERNAL}, keep: ${KEEP})`);

    try {
        await fetch(`${BASE_URL}/health`);
    } catch {
        console.error(
            `\n\x1b[31mServer not reachable at ${BASE_URL}.\x1b[0m Start it with \`npm run dev\`.`,
        );
        process.exit(1);
    }

    begin("System");
    await step("GET /health returns ok", async () => {
        const res = await a.get("/health");
        expectStatus(res, 200);
        expect(res.body?.data?.status === "ok", "status is not ok");
    });
    await step("GET /health/ready: required dependencies are up", async () => {
        const res = await a.get("/health/ready");
        const report = res.body?.data ?? res.body?.error?.details;
        const checks = Object.entries((report?.checks ?? {}) as Record<string, any>);
        const down = checks
            .filter(([, c]) => c.status === "down")
            .map(([name, c]) => `${name}: ${c.error ?? "down"}`);
        expect(res.status === 200, `status ${report?.status}; down → ${down.join(", ")}`);
        return checks.map(([name, c]) => `${name} ${c.status}`).join(", ");
    });
    await step("unknown route returns 404 envelope", async () => {
        const res = await a.get("/api/does-not-exist");
        expectStatus(res, 404);
        expect(
            res.body?.success === false && res.body.error?.code === "NOT_FOUND",
            "bad error envelope",
        );
    });
    await step("responses carry X-Request-Id", async () => {
        const res = await a.get("/health");
        expect(res.headers.get("x-request-id"), "missing X-Request-Id");
    });

    begin("Auth");
    await step("GET /api/me without session is 401", async () => {
        expectStatus(await a.get("/api/me"), 401);
    });
    await step("sign up user A", async () => {
        const res = await a.post("/api/auth/sign-up/email", userA);
        expectStatus(res, 200);
        return userA.email;
    });
    await step("sign in user A", async () => {
        expectStatus(
            await a.post("/api/auth/sign-in/email", { email: userA.email, password: PASSWORD }),
            200,
        );
    });
    await step("wrong password is rejected", async () => {
        const res = await new Client("x").post("/api/auth/sign-in/email", {
            email: userA.email,
            password: "wrong-password-1",
        });
        expect(res.status === 401, `expected 401, got ${res.status}`);
    });
    await step("GET /api/me returns user A", async () => {
        const res = await a.get("/api/me");
        expectStatus(res, 200);
        expect(res.body?.data?.email === userA.email, "wrong user");
    });
    await step("sign up + sign in user B (for isolation checks)", async () => {
        expectStatus(await b.post("/api/auth/sign-up/email", userB), 200);
        expectStatus(
            await b.post("/api/auth/sign-in/email", { email: userB.email, password: PASSWORD }),
            200,
        );
    });

    begin("Workspaces");
    await step("blank title is a validation error", async () => {
        const res = await a.post("/api/workspaces", { title: "  " });
        expectStatus(res, 400);
        expect(res.body?.error?.code === "VALIDATION_ERROR", `code ${res.body?.error?.code}`);
    });
    await step("create workspace", async () => {
        const res = await a.post("/api/workspaces", {
            title: "Smoke test biology",
            description: "Created by smoke test",
        });
        expectStatus(res, 201);
        state.workspaceId = res.body?.data?.id;
        expect(state.workspaceId, "no id returned");
        return state.workspaceId;
    });
    await step("list workspaces includes it", async () => {
        const res = await a.get("/api/workspaces");
        expectStatus(res, 200);
        expect(
            (res.body?.data as any[]).some((w) => w.id === state.workspaceId),
            "not listed",
        );
    });
    await step("get workspace", async () => {
        expectStatus(await a.get(ws()), 200);
    });
    await step("workspace carries sourceCount and artifactCount", async () => {
        const res = await a.get("/api/workspaces");
        const mine = (res.body?.data as any[]).find((w) => w.id === state.workspaceId);
        expect(
            typeof mine?.sourceCount === "number" && typeof mine?.artifactCount === "number",
            "counts missing from the list",
        );
        const one = await a.get(ws());
        expect(typeof one.body?.data?.sourceCount === "number", "counts missing from get");
    });
    await step("search and sort the workspace list", async () => {
        const hit = await a.get("/api/workspaces?q=BIOLOGY");
        expectStatus(hit, 200);
        expect(
            (hit.body?.data as any[]).some((w) => w.id === state.workspaceId),
            "q is not case-insensitive or does not match the title",
        );
        const miss = await a.get("/api/workspaces?q=zzz-no-such-notebook");
        expect((miss.body?.data as any[]).length === 0, "q did not filter");
        expectStatus(await a.get("/api/workspaces?sort=title&order=asc"), 200);
        expectStatus(await a.get("/api/workspaces?sort=updatedAt"), 200);
        expectStatus(await a.get("/api/workspaces?sort=bogus"), 400);
    });
    await step("workspace summary", async () => {
        const res = await a.get(ws("/summary"));
        expectStatus(res, 200);
        const s = res.body?.data;
        expect(
            [
                "sourceCount",
                "readySourceCount",
                "processingArtifactCount",
                "unseenArtifactCount",
            ].every((key) => typeof s?.[key] === "number"),
            "summary is missing a count",
        );
        expectStatus(await b.get(ws("/summary")), 404);
    });
    await step("icon accepts a short key", async () => {
        expectStatus(await a.patch(ws(), { icon: "compass" }), 200);
        expectStatus(await a.patch(ws(), { icon: "x".repeat(9) }), 400);
    });
    await step("update workspace", async () => {
        const res = await a.patch(ws(), {
            title: "Smoke test biology (renamed)",
            defaultModel: "gpt-4o-mini",
        });
        expectStatus(res, 200);
        expect(res.body?.data?.title === "Smoke test biology (renamed)", "title not updated");
    });
    await step("update with empty body is 400", async () => {
        expectStatus(await a.patch(ws(), {}), 400);
    });
    await step("user B cannot see user A's workspace (404)", async () => {
        expectStatus(await b.get(ws()), 404);
    });

    begin("Sources");
    await step("create TEXT source", async () => {
        const res = await a.post(ws("/sources"), {
            type: "TEXT",
            title: "Photosynthesis notes",
            content: TEXT_SOURCE,
        });
        expectStatus(res, 201);
        state.textSourceId = res.body?.data?.id;
        return res.body?.data?.status;
    });
    await step("create MARKDOWN source", async () => {
        const res = await a.post(ws("/sources"), {
            type: "MARKDOWN",
            title: "Respiration",
            content: MARKDOWN_SOURCE,
        });
        expectStatus(res, 201);
        state.markdownSourceId = res.body?.data?.id;
    });
    await step("PDF type via JSON is rejected", async () => {
        expectStatus(await a.post(ws("/sources"), { type: "PDF", title: "x", content: "x" }), 400);
    });
    await step("list sources omits content", async () => {
        const res = await a.get(ws("/sources"));
        expectStatus(res, 200);
        const sources = res.body?.data as any[];
        expect(sources.length === 2, `expected 2, got ${sources.length}`);
        expect(
            sources.every((s) => !("content" in s)),
            "content included in list",
        );
    });
    await step("sources paginate with limit and cursor", async () => {
        const full = await a.get(ws("/sources"));
        expect(full.body?.meta?.total === 2, `meta.total ${full.body?.meta?.total}`);
        expect(full.body?.meta?.nextCursor === null, "unpaged list has a nextCursor");

        const first = await a.get(ws("/sources?limit=1"));
        expectStatus(first, 200);
        expect((first.body?.data as any[]).length === 1, "page size not applied");
        expect(first.body?.meta?.total === 2, "total missing");
        const cursor = first.body?.meta?.nextCursor as string;
        expect(typeof cursor === "string", "no nextCursor on the first page");

        const second = await a.get(ws(`/sources?limit=1&cursor=${cursor}`));
        expectStatus(second, 200);
        expect((second.body?.data as any[]).length === 1, "second page is empty");
        expect(second.body?.data[0].id !== first.body?.data[0].id, "pages overlap");
        expect(second.body?.meta?.nextCursor === null, "last page has a nextCursor");
        expectStatus(await a.get(ws("/sources?limit=0")), 400);
        expectStatus(await a.get(ws("/sources?limit=101")), 400);
    });
    await step("list sources with ?type filter", async () => {
        const res = await a.get(ws("/sources?type=TEXT"));
        expectStatus(res, 200);
        expect((res.body?.data as any[]).length === 1, "filter not applied");
    });
    await step("get one source includes content", async () => {
        const res = await a.get(ws(`/sources/${state.textSourceId}`));
        expectStatus(res, 200);
        expect(typeof res.body?.data?.content === "string", "no content");
    });
    await step("user B cannot read user A's source (404)", async () => {
        expectStatus(await b.get(ws(`/sources/${state.textSourceId}`)), 404);
    });

    if (AI) {
        await step("background job indexes sources to READY", async () => {
            await waitForSource(a, state.workspaceId, state.textSourceId);
            await waitForSource(a, state.workspaceId, state.markdownSourceId);
        });
        await step("chunks have content and token counts", async () => {
            const res = await a.get(ws(`/sources/${state.textSourceId}/chunks`));
            expectStatus(res, 200);
            const { chunks, count } = res.body?.data as { chunks: any[]; count: number };
            expect(count > 0, "no chunks");
            expect(
                chunks.every((c) => c.content && c.tokenCount > 0),
                "chunk missing content/tokenCount",
            );
            return `${count} chunks`;
        });
        await step("reprocess one source (202) and it returns to READY", async () => {
            expectStatus(await a.post(ws(`/sources/${state.markdownSourceId}/reprocess`)), 202);
            await sleep(1_000);
            await waitForSource(a, state.workspaceId, state.markdownSourceId);
        });
        await step("reprocess failed sources (none) is a no-op", async () => {
            const res = await a.post(ws("/sources/reprocess"), {});
            expectStatus(res, 200);
            return `reprocessed: ${res.body?.data?.reprocessed}`;
        });
        await step("reprocess an explicit selection touches only those ids", async () => {
            const res = await a.post(ws("/sources/reprocess"), {
                sourceIds: [state.markdownSourceId, "no-such-source"],
            });
            expectStatus(res, 200);
            const { reprocessed, results } = res.body?.data as {
                reprocessed: number;
                results: { sourceId: string; status: string }[];
            };
            const statusOf = (id: string) => results.find((r) => r.sourceId === id)?.status;
            expect(
                statusOf(state.markdownSourceId) === "queued",
                "selected READY source not queued",
            );
            expect(statusOf("no-such-source") === "not_found", "unknown id not reported");
            expect(
                statusOf(state.textSourceId) === undefined,
                "a source outside the selection was touched",
            );
            expect(reprocessed === 1, `reprocessed ${reprocessed}`);
            await sleep(1_000);
            await waitForSource(a, state.workspaceId, state.markdownSourceId);
        });
    }

    if (AI) {
        begin("Chat (RAG)");
        await step("first message streams a grounded reply", async () => {
            const res = await a.post(ws("/chat"), {
                messages: [userMessage("Where does the Calvin cycle happen?")],
            });
            expectStatus(res, 200);
            state.conversationId = res.headers.get("x-conversation-id") ?? "";
            expect(state.conversationId, "missing X-Conversation-Id");
            const reply = readChatStream(res.text);
            expect(reply.length > 0, "empty reply");
            return reply.slice(0, 60).replace(/\s+/g, " ") + "…";
        });
        await step("follow-up in the same conversation", async () => {
            const res = await a.post(ws("/chat"), {
                conversationId: state.conversationId,
                messages: [userMessage("And what does it produce?")],
            });
            expectStatus(res, 200);
            expect(readChatStream(res.text).length > 0, "empty reply");
        });
        await step("messages are saved with marker-based citations", async () => {
            const res = await a.get(ws(`/conversations/${state.conversationId}/messages`));
            expectStatus(res, 200);
            const messages = res.body?.data as any[];
            expect(messages.length >= 4, `expected >= 4 messages, got ${messages.length}`);
            const citations = messages
                .filter((m) => m.role === "ASSISTANT")
                .flatMap((m) => (m.citations as any[]) ?? []);
            expect(
                citations.every((c) => typeof c.marker === "number"),
                "citation without marker",
            );
            expect(
                citations.every((c) => c.sourceType === "WEB" || typeof c.chunkTotal === "number"),
                "source citation without chunkTotal",
            );
            return `${citations.length} citations`;
        });
        await step("conversation is listed with a title", async () => {
            const res = await a.get(ws("/conversations"));
            expectStatus(res, 200);
            const conversation = (res.body?.data as any[]).find(
                (c) => c.id === state.conversationId,
            );
            expect(conversation?.title, "conversation missing or untitled");
            return conversation.title as string;
        });
        await step("empty messages is 400", async () => {
            expectStatus(await a.post(ws("/chat"), { messages: [] }), 400);
        });
        await step("user B cannot chat in user A's workspace (404)", async () => {
            expectStatus(await b.post(ws("/chat"), { messages: [userMessage("hi")] }), 404);
        });
    }

    begin("Conversations");
    await step("create and delete an empty conversation", async () => {
        const res = await a.post(ws("/conversations"), { title: "Empty conversation" });
        expectStatus(res, 201);
        expectStatus(await a.delete(ws(`/conversations/${res.body?.data?.id}`)), 204);
    });

    await step("rename a conversation", async () => {
        const created = await a.post(ws("/conversations"), { title: "Before" });
        expectStatus(created, 201);
        const path = ws(`/conversations/${created.body?.data?.id}`);

        const renamed = await a.patch(path, { title: "  After rename  " });
        expectStatus(renamed, 200);
        expect(renamed.body?.data?.title === "After rename", "title not trimmed and saved");
        expect(renamed.body?.data?.id === created.body?.data?.id, "different conversation");

        expectStatus(await a.patch(path, { title: "" }), 400);
        expectStatus(await a.patch(path, { title: "x".repeat(121) }), 400);
        expectStatus(await a.patch(path, {}), 400);
        expectStatus(await a.patch(path, { title: "ok", summary: "nope" }), 400);
        expectStatus(await b.patch(path, { title: "hijack" }), 404);
        expectStatus(await a.patch(ws("/conversations/no-such-chat"), { title: "x" }), 404);

        const listed = (await a.get(ws("/conversations"))).body?.data as any[];
        expect(
            listed.find((c) => c.id === created.body?.data?.id)?.title === "After rename",
            "rename not persisted",
        );
        expectStatus(await a.delete(path), 204);
    });

    begin("Source editing and chunk exclusion");
    /** Path under the dedicated workspace for the edit tests (keeps their facts out of other tests). */
    const ew = (path = "") => `/api/workspaces/${state.editWorkspaceId}${path}`;
    await step("create a workspace and a source to edit", async () => {
        const workspace = await a.post("/api/workspaces", { title: "Smoke source editing" });
        expectStatus(workspace, 201);
        state.editWorkspaceId = workspace.body?.data?.id;

        const source = await a.post(ew("/sources"), {
            type: "TEXT",
            title: "Atlantis facts",
            content: ATLANTIS_V1,
        });
        expectStatus(source, 201);
        state.editSourceId = source.body?.data?.id;
    });
    await step("PATCH source validation", async () => {
        const path = ew(`/sources/${state.editSourceId}`);
        expectStatus(await a.patch(path, {}), 400);
        expectStatus(await a.patch(path, { title: "" }), 400);
        expectStatus(await a.patch(path, { title: "x".repeat(201) }), 400);
        expectStatus(await a.patch(path, { content: "" }), 400);
        expectStatus(await a.patch(path, { title: "ok", type: "PDF" }), 400);
        expectStatus(await a.patch(path, { title: "ok", expectedUpdatedAt: "yesterday" }), 400);
        expectStatus(await a.patch(ew("/sources/no-such-source"), { title: "x" }), 404);
    });
    await step("user B cannot edit user A's source (404)", async () => {
        expectStatus(await b.patch(ew(`/sources/${state.editSourceId}`), { title: "hijack" }), 404);
    });
    await step("content of a non-text source is rejected (400)", async () => {
        const website = await a.post(ew("/sources/import/web-search"), {
            title: "Saved page",
            content: "Some saved page text.",
            url: "https://example.com/page",
        });
        expectStatus(website, 201);
        const path = ew(`/sources/${website.body?.data?.id}`);
        const res = await a.patch(path, { content: "Replacement text" });
        expectStatus(res, 400);
        expect(/text and markdown/i.test(res.body?.error?.message ?? ""), "unclear message");
        state.websiteSourceId = website.body?.data?.id;
    });
    await step("a source that is still processing cannot be edited (409)", async () => {
        const fresh = await a.post(ew("/sources"), {
            type: "TEXT",
            title: "Busy",
            content: "Busy source text that is being indexed right now.",
        });
        expectStatus(fresh, 201);
        const res = await a.patch(ew(`/sources/${fresh.body?.data?.id}`), { title: "Renamed" });
        if (res.status === 200) throw new Skip("source finished indexing before the request");
        expectStatus(res, 409);
        state.busySourceId = fresh.body?.data?.id;
    });

    if (AI) {
        await step("source is indexed and answers from the original text", async () => {
            await waitForSource(a, state.editWorkspaceId, state.editSourceId);
            const { reply } = await askChat(
                a,
                state.editWorkspaceId,
                "What is the capital of Atlantis?",
            );
            expect(/Poseidonia/i.test(reply), `reply: ${reply.slice(0, 120)}`);
        });
        await step(
            "title edit updates the title and the chat citations, without re-indexing",
            async () => {
                const before = (await a.get(ew(`/sources/${state.editSourceId}`))).body?.data;
                const res = await a.patch(ew(`/sources/${state.editSourceId}`), {
                    title: "  Atlantis atlas  ",
                    expectedUpdatedAt: before.updatedAt,
                });
                expectStatus(res, 200);
                const after = res.body?.data;
                expect(after.title === "Atlantis atlas", "title not trimmed and saved");
                expect(
                    after.status === "READY",
                    `status ${after.status}: a title edit must not re-index`,
                );
                expect(after.content === before.content, "content changed");
                expect(
                    after.metadata?.indexedAt === before.metadata?.indexedAt,
                    "source was re-indexed",
                );
                expect(after.updatedAt !== before.updatedAt, "updatedAt not bumped");

                const { citations } = await askUntilCited(
                    a,
                    state.editWorkspaceId,
                    ATLANTIS_QUESTION,
                    (found) => found.some((c) => c.sourceId === state.editSourceId),
                );
                const cited = citations.filter((c) => c.sourceId === state.editSourceId);
                expect(cited.length > 0, "source not cited");
                expect(
                    cited.every((c) => c.sourceTitle === "Atlantis atlas"),
                    `citations still show ${cited[0]?.sourceTitle}`,
                );
            },
        );
        await step("a stale expectedUpdatedAt is rejected with 409 CONFLICT", async () => {
            const res = await a.patch(ew(`/sources/${state.editSourceId}`), {
                title: "Stale write",
                expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
            });
            expectStatus(res, 409);
            expect(res.body?.error?.code === "CONFLICT", `code ${res.body?.error?.code}`);
            expect(
                res.body?.error?.message ===
                    "This item was changed elsewhere. Reload and try again.",
                "wrong message",
            );
            const current = (await a.get(ew(`/sources/${state.editSourceId}`))).body?.data;
            expect(current.title === "Atlantis atlas", "a rejected write changed the title");
        });
        await step(
            "concurrent edits from one version: exactly one wins (compare-and-set)",
            async () => {
                const current = (await a.get(ew(`/sources/${state.editSourceId}`))).body?.data;
                const path = ew(`/sources/${state.editSourceId}`);
                const [one, two] = await Promise.all([
                    a.patch(path, { title: "Race one", expectedUpdatedAt: current.updatedAt }),
                    a.patch(path, { title: "Race two", expectedUpdatedAt: current.updatedAt }),
                ]);
                const statuses = [one.status, two.status].sort();
                expect(
                    statuses[0] === 200 && statuses[1] === 409,
                    `statuses ${statuses.join(", ")}`,
                );
                await a.patch(path, { title: "Atlantis atlas" });
            },
        );
        await step(
            "content edit replaces the old text: nothing of it is left to retrieve",
            async () => {
                const path = ew(`/sources/${state.editSourceId}`);
                const res = await a.patch(path, { content: ATLANTIS_V2 });
                expectStatus(res, 200);
                expect(res.body?.data?.status === "PENDING", `status ${res.body?.data?.status}`);
                expect(res.body?.data?.content === ATLANTIS_V2, "content not saved");

                // Queued or running: a second edit has to wait.
                expectStatus(await a.patch(path, { title: "Too soon" }), 409);

                await sleep(1_000);
                const ready = await waitForSource(a, state.editWorkspaceId, state.editSourceId);
                expect(ready.title === "Atlantis atlas", "title lost");

                const { chunks } = (await a.get(ew(`/sources/${state.editSourceId}/chunks`))).body
                    ?.data as {
                    chunks: any[];
                };
                expect(chunks.length > 0, "no chunks after re-index");
                expect(
                    !chunks.some((c) => /Poseidonia/i.test(c.content)),
                    "old text still in a chunk",
                );
                expect(
                    chunks.some((c) => /Meridia/i.test(c.content)),
                    "new text not chunked",
                );

                const { reply } = await askChat(
                    a,
                    state.editWorkspaceId,
                    "What is the capital of Atlantis?",
                );
                expect(/Meridia/i.test(reply), `reply: ${reply.slice(0, 120)}`);
                expect(!/Poseidonia/i.test(reply), "answer still mentions the old capital");
            },
        );
        await step("sending identical content does not re-index", async () => {
            const before = (await a.get(ew(`/sources/${state.editSourceId}`))).body?.data;
            const res = await a.patch(ew(`/sources/${before.id}`), { content: before.content });
            expectStatus(res, 200);
            expect(res.body?.data?.status === "READY", "identical content re-queued the source");
            expect(
                res.body?.data?.updatedAt === before.updatedAt,
                "a no-op edit changed updatedAt",
            );
        });

        await step(
            "GET chunks includes excluded, PATCH chunk validation and ownership",
            async () => {
                const { chunks } = (await a.get(ew(`/sources/${state.editSourceId}/chunks`))).body
                    ?.data as {
                    chunks: any[];
                };
                expect(
                    chunks.every((c) => c.excluded === false),
                    "excluded missing or true by default",
                );
                state.chunkId = chunks[0].id;

                const path = ew(`/sources/${state.editSourceId}/chunks/${state.chunkId}`);
                expectStatus(await a.patch(path, {}), 400);
                expectStatus(await a.patch(path, { excluded: "yes" }), 400);
                expectStatus(await a.patch(path, { excluded: true, extra: 1 }), 400);
                expectStatus(
                    await a.patch(ew(`/sources/${state.editSourceId}/chunks/no-such-chunk`), {
                        excluded: true,
                    }),
                    404,
                );
                expectStatus(
                    await a.patch(ew(`/sources/no-such-source/chunks/${state.chunkId}`), {
                        excluded: true,
                    }),
                    404,
                );
                expectStatus(await b.patch(path, { excluded: true }), 404);
                // A chunk id from another source is not found under this one.
                expectStatus(
                    await a.patch(
                        `/api/workspaces/${state.workspaceId}/sources/${state.textSourceId}/chunks/${state.chunkId}`,
                        { excluded: true },
                    ),
                    404,
                );
            },
        );
        await step(
            "an excluded chunk is skipped by retrieval; re-including brings it back",
            async () => {
                const path = ew(`/sources/${state.editSourceId}/chunks/${state.chunkId}`);
                const excluded = await a.patch(path, { excluded: true });
                expectStatus(excluded, 200);
                expect(excluded.body?.data?.excluded === true, "chunk not excluded");

                const listed = (await a.get(ew(`/sources/${state.editSourceId}/chunks`))).body
                    ?.data as {
                    chunks: any[];
                };
                expect(
                    listed.chunks.find((c) => c.id === state.chunkId)?.excluded === true,
                    "flag not listed",
                );

                // Pinecone is eventually consistent; give the metadata update a moment.
                await sleep(6_000);
                const hidden = await askChat(
                    a,
                    state.editWorkspaceId,
                    "What is the capital of Atlantis?",
                );
                expect(
                    !hidden.citations.some((c) => c.chunkId === state.chunkId),
                    "excluded chunk was still cited",
                );
                expect(!/Meridia/i.test(hidden.reply), "excluded text still reached the answer");

                expectStatus(await a.patch(path, { excluded: false }), 200);
                await sleep(6_000);
                const back = await askUntilCited(
                    a,
                    state.editWorkspaceId,
                    ATLANTIS_QUESTION,
                    (found) => found.some((c) => c.chunkId === state.chunkId),
                );
                expect(
                    back.citations.some((c) => c.chunkId === state.chunkId),
                    "re-included chunk not retrievable",
                );
            },
        );
    }

    begin("Memory");
    await step("create memory", async () => {
        const res = await a.post("/api/memory", { memory: "Prefers short answers with examples." });
        skipIfNotConfigured(res);
        expectStatus(res, 201);
        state.memoryId = res.body?.data?.id;
    });
    await step("list, update, isolate, delete memory", async () => {
        if (!state.memoryId) throw new Skip("no memory created");
        expectStatus(await a.get("/api/memory"), 200);
        expectStatus(
            await a.patch(`/api/memory/${state.memoryId}`, { memory: "Prefers concise answers." }),
            200,
        );
        expectStatus(await b.delete(`/api/memory/${state.memoryId}`), 404);
        expectStatus(await a.delete(`/api/memory/${state.memoryId}`), 204);
    });
    await step("empty memory is 400", async () => {
        expectStatus(await a.post("/api/memory", { memory: "" }), 400);
    });

    begin("Artifacts");
    await step("unknown type is 400", async () => {
        expectStatus(await a.post(ws("/artifacts"), { type: "POEM" }), 400);
    });
    await step("workspace without READY sources is 400", async () => {
        const res = await a.post("/api/workspaces", { title: "Smoke test empty" });
        expectStatus(res, 201);
        state.emptyWorkspaceId = res.body?.data?.id;
        expectStatus(
            await a.post(`/api/workspaces/${state.emptyWorkspaceId}/artifacts`, {
                type: "SUMMARY",
            }),
            400,
        );
    });
    await step("WIKI without a GitHub source is 400", async () => {
        expectStatus(await a.post(ws("/artifacts"), { type: "WIKI" }), 400);
    });
    await step("PATCH and regenerate on an unknown artifact are 404", async () => {
        expectStatus(await a.patch(ws("/artifacts/no-such-artifact"), { title: "x" }), 404);
        expectStatus(await a.post(ws("/artifacts/no-such-artifact/regenerate"), {}), 404);
    });
    await step("PATCH artifact body validation", async () => {
        const path = ws("/artifacts/no-such-artifact");
        expectStatus(await a.patch(path, {}), 400);
        expectStatus(await a.patch(path, { title: "" }), 400);
        expectStatus(await a.patch(path, { title: "x".repeat(201) }), 400);
        expectStatus(await a.patch(path, { content: "not an object" }), 400);
        expectStatus(await a.patch(path, { type: "QUIZ", title: "x" }), 400);
        expectStatus(await a.patch(path, { title: "x", expectedUpdatedAt: "soon" }), 400);
        expectStatus(
            await a.post(ws("/artifacts/no-such-artifact/regenerate"), { force: "yes" }),
            400,
        );
        expectStatus(await a.post(ws("/artifacts/no-such-artifact/regenerate"), { bogus: 1 }), 400);
    });
    await step("bulk delete artifacts: validation, ownership and unknown ids", async () => {
        const path = ws("/artifacts/bulk-delete");
        expectStatus(await a.post(path, {}), 400);
        expectStatus(await a.post(path, { artifactIds: [] }), 400);
        expectStatus(
            await a.post(path, { artifactIds: Array.from({ length: 101 }, (_, i) => `id-${i}`) }),
            400,
        );
        expectStatus(await a.post(path, { artifactIds: ["x"], extra: true }), 400);
        expectStatus(await b.post(path, { artifactIds: ["x"] }), 404);

        const res = await a.post(path, { artifactIds: ["no-such-artifact", "no-such-artifact"] });
        expectStatus(res, 200);
        const { deleted, results } = res.body?.data as { deleted: number; results: any[] };
        expect(deleted === 0, `deleted ${deleted}`);
        expect(
            results.length === 1 && results[0].status === "not_found",
            "unknown id not reported",
        );
    });
    await step("artifact list ?q matches nothing when there are no artifacts", async () => {
        const res = await a.get(`/api/workspaces/${state.emptyWorkspaceId}/artifacts?q=anything`);
        expectStatus(res, 200);
        expect((res.body?.data as any[]).length === 0, "unexpected artifacts");
        expect(res.body?.meta?.total === 0, "meta.total");
        expect(res.body?.meta?.nextCursor === null, "meta.nextCursor");
    });

    if (AI) {
        for (const type of ["SUMMARY", "QUIZ"] as const) {
            await step(`generate ${type} to READY`, async () => {
                const created = await a.post(ws("/artifacts"), { type });
                expectStatus(created, 201);
                const id = created.body?.data?.id as string;
                const artifact = await poll(
                    async () => (await a.get(ws(`/artifacts/${id}`))).body?.data,
                    (x) => x?.status === "READY" || x?.status === "FAILED",
                    ARTIFACT_TIMEOUT_MS,
                    INNGEST_HINT,
                );
                expect(artifact.status === "READY", `artifact ended ${artifact.status}`);
                if (type === "SUMMARY") {
                    expect(
                        typeof artifact.content?.markdown === "string",
                        "summary has no markdown",
                    );
                    expect(Array.isArray(artifact.content?.citations), "summary has no citations");
                    expect(
                        (artifact.content.citations as any[]).every(
                            (c) => c.sourceId && c.label && typeof c.marker === "number",
                        ),
                        "malformed summary citation",
                    );
                } else {
                    const questions = artifact.content?.questions as any[];
                    expect(questions?.length > 0, "quiz has no questions");
                    expect(
                        questions.every(
                            (q) => q.correctIndex >= 0 && q.correctIndex < q.options.length,
                        ),
                        "correctIndex out of range",
                    );
                    expect(
                        questions.every((q) => Array.isArray(q.citations)),
                        "quiz question without citations array",
                    );
                }
                state[`artifact${type}`] = id;
            });
        }
        await step("artifact input validation", async () => {
            expectStatus(
                await a.post(ws("/artifacts"), { type: "SUMMARY", messageIds: ["m1"] }),
                400,
            );
            expectStatus(
                await a.post(ws("/artifacts"), {
                    type: "SUMMARY",
                    conversationId: "c1",
                    sourceIds: ["s1"],
                }),
                400,
            );
            expectStatus(
                await a.post(ws("/artifacts"), { type: "WIKI", conversationId: "c1" }),
                400,
            );
            expectStatus(
                await a.post(ws("/artifacts"), { type: "SUMMARY", conversationId: "no-such-chat" }),
                404,
            );
        });
        if (AI) {
            await step("viewed tracking clears the unseen count", async () => {
                if (!state.artifactSUMMARY) throw new Skip("no artifact generated");
                const before = (await a.get(ws("/summary"))).body?.data;
                expect(before.unseenArtifactCount >= 1, `unseen ${before.unseenArtifactCount}`);
                const artifact = (await a.get(ws(`/artifacts/${state.artifactSUMMARY}`))).body
                    ?.data;
                expect(artifact.viewedAt === null, "reading an artifact must not mark it viewed");
                expectStatus(await a.post(ws(`/artifacts/${state.artifactSUMMARY}/viewed`)), 204);
                expectStatus(await a.post(ws(`/artifacts/${state.artifactSUMMARY}/viewed`)), 204);
                const after = (await a.get(ws("/summary"))).body?.data;
                expect(
                    after.unseenArtifactCount === before.unseenArtifactCount - 1,
                    `unseen ${before.unseenArtifactCount} -> ${after.unseenArtifactCount}`,
                );
                const opened = (await a.get(ws(`/artifacts/${state.artifactSUMMARY}`))).body?.data;
                expect(typeof opened.viewedAt === "string", "viewedAt not set");
                expectStatus(await b.post(ws(`/artifacts/${state.artifactSUMMARY}/viewed`)), 404);
            });
            await step("generate FLASHCARDS from the conversation", async () => {
                if (!state.conversationId) throw new Skip("no conversation");
                const created = await a.post(ws("/artifacts"), {
                    type: "FLASHCARDS",
                    conversationId: state.conversationId,
                });
                expectStatus(created, 201);
                const id = created.body?.data?.id as string;
                const artifact = await poll(
                    async () => (await a.get(ws(`/artifacts/${id}`))).body?.data,
                    (x) => x?.status === "READY" || x?.status === "FAILED",
                    ARTIFACT_TIMEOUT_MS,
                    INNGEST_HINT,
                );
                expect(artifact.status === "READY", `artifact ended ${artifact.status}`);
                const cards = artifact.content?.cards as any[];
                expect(cards?.length > 0, "no cards");
                expect(
                    cards.every((c) => Array.isArray(c.citations)),
                    "card without citations array",
                );
                expect(
                    artifact.metadata?.conversationId === state.conversationId,
                    "conversation not recorded",
                );
            });
            await step("generate FLASHCARDS from sources with per-card citations", async () => {
                const created = await a.post(ws("/artifacts"), { type: "FLASHCARDS" });
                expectStatus(created, 201);
                const id = created.body?.data?.id as string;
                const artifact = await poll(
                    async () => (await a.get(ws(`/artifacts/${id}`))).body?.data,
                    (x) => x?.status === "READY" || x?.status === "FAILED",
                    ARTIFACT_TIMEOUT_MS,
                    INNGEST_HINT,
                );
                expect(artifact.status === "READY", `artifact ended ${artifact.status}`);
                const cards = artifact.content?.cards as any[];
                const cited = cards.filter((c) => c.citations.length > 0);
                expect(cited.length > 0, "no card cites a source");
                expect(
                    cited.every((c) =>
                        c.citations.every(
                            (x: any) =>
                                [state.textSourceId, state.markdownSourceId].includes(x.sourceId) &&
                                x.label,
                        ),
                    ),
                    "citation does not point at a workspace source",
                );
            });
        }
        await step(
            "generated artifacts get a topic title instead of the date default",
            async () => {
                for (const type of ["SUMMARY", "QUIZ"] as const) {
                    const artifact = (await a.get(ws(`/artifacts/${state[`artifact${type}`]}`)))
                        .body?.data;
                    expect(
                        !artifact.title.includes("\u00b7"),
                        `still default: "${artifact.title}"`,
                    );
                    expect(
                        artifact.title.length >= 2 && artifact.title.length <= 80,
                        "odd title length",
                    );
                }
            },
        );
        await step("a custom title is kept at creation", async () => {
            const created = await a.post(ws("/artifacts"), {
                type: "TAKEAWAYS",
                title: "My takeaways",
            });
            expectStatus(created, 201);
            const done = await poll(
                async () => (await a.get(ws(`/artifacts/${created.body?.data?.id}`))).body?.data,
                (x) => x?.status === "READY" || x?.status === "FAILED",
                ARTIFACT_TIMEOUT_MS,
                INNGEST_HINT,
            );
            expect(done.status === "READY", `ended ${done.status}`);
            expect(done.title === "My takeaways", `title became "${done.title}"`);
        });
        await step("generate MINDMAP to READY", async () => {
            const created = await a.post(ws("/artifacts"), { type: "MINDMAP" });
            expectStatus(created, 201);
            const id = created.body?.data?.id as string;
            const artifact = await poll(
                async () => (await a.get(ws(`/artifacts/${id}`))).body?.data,
                (x) => x?.status === "READY" || x?.status === "FAILED",
                ARTIFACT_TIMEOUT_MS,
                INNGEST_HINT,
            );
            expect(artifact.status === "READY", `artifact ended ${artifact.status}`);
            state.artifactMINDMAP = id;
        });

        begin("Artifact editing and regeneration");
        await step("user B cannot edit or regenerate user A's artifact (404)", async () => {
            expectStatus(
                await b.patch(ws(`/artifacts/${state.artifactQUIZ}`), { title: "x" }),
                404,
            );
            expectStatus(await b.post(ws(`/artifacts/${state.artifactQUIZ}/regenerate`), {}), 404);
        });
        await step("title edit renames without marking the content edited", async () => {
            const before = (await a.get(ws(`/artifacts/${state.artifactSUMMARY}`))).body?.data;
            const res = await a.patch(ws(`/artifacts/${state.artifactSUMMARY}`), {
                title: "  Renamed summary  ",
                expectedUpdatedAt: before.updatedAt,
            });
            expectStatus(res, 200);
            expect(res.body?.data?.title === "Renamed summary", "title not trimmed and saved");
            expect(res.body?.data?.type === "SUMMARY", "type changed");
            expect(
                JSON.stringify(res.body?.data?.content) === JSON.stringify(before.content),
                "content changed",
            );
            expect(
                !res.body?.data?.metadata?.userEdited,
                "a rename must not mark the content edited",
            );
            expect(res.body?.data?.updatedAt !== before.updatedAt, "updatedAt not bumped");
        });
        await step(
            "content is validated against the artifact's own type, with field details",
            async () => {
                const quiz = (await a.get(ws(`/artifacts/${state.artifactQUIZ}`))).body?.data;
                const path = ws(`/artifacts/${state.artifactQUIZ}`);

                const outOfRange = structuredClone(quiz.content);
                outOfRange.questions[0].correctIndex = outOfRange.questions[0].options.length;
                const res = await a.patch(path, { content: outOfRange });
                expectStatus(res, 400);
                expect(
                    res.body?.error?.code === "VALIDATION_ERROR",
                    `code ${res.body?.error?.code}`,
                );
                expect(
                    Object.keys(res.body?.error?.details ?? {}).includes(
                        "content.questions.0.correctIndex",
                    ),
                    `details ${JSON.stringify(res.body?.error?.details)}`,
                );

                // Another type's shape, an unknown key and a too-short list are all refused.
                expectStatus(await a.patch(path, { content: { cards: [] } }), 400);
                expectStatus(
                    await a.patch(path, { content: { ...quiz.content, extra: true } }),
                    400,
                );
                expectStatus(
                    await a.patch(path, {
                        content: { questions: quiz.content.questions.slice(0, 1) },
                    }),
                    400,
                );
                expectStatus(
                    await a.patch(ws(`/artifacts/${state.artifactSUMMARY}`), {
                        content: { markdown: 5 },
                    }),
                    400,
                );

                const unchanged = (await a.get(path)).body?.data;
                expect(
                    JSON.stringify(unchanged.content) === JSON.stringify(quiz.content),
                    "a rejected edit changed the content",
                );
            },
        );
        await step(
            "valid content edit is saved, citations kept as sent, marked userEdited",
            async () => {
                const before = (await a.get(ws(`/artifacts/${state.artifactQUIZ}`))).body?.data;
                const content = structuredClone(before.content);
                content.questions[0].question = "Edited by the user: which statement is correct?";

                const res = await a.patch(ws(`/artifacts/${state.artifactQUIZ}`), {
                    content,
                    expectedUpdatedAt: before.updatedAt,
                });
                expectStatus(res, 200);
                const after = res.body?.data;
                expect(
                    after.content.questions[0].question === content.questions[0].question,
                    "edit not saved",
                );
                expect(
                    JSON.stringify(after.content.questions[0].citations) ===
                        JSON.stringify(before.content.questions[0].citations),
                    "citations were not preserved",
                );
                expect(after.metadata?.userEdited === true, "userEdited not set");
                expect(typeof after.metadata?.editedAt === "string", "editedAt not set");
                expect(after.status === "READY" && after.type === "QUIZ", "status or type changed");
                expect(after.updatedAt !== before.updatedAt, "updatedAt not bumped");
            },
        );
        await step("a stale expectedUpdatedAt is rejected with 409 CONFLICT", async () => {
            const res = await a.patch(ws(`/artifacts/${state.artifactQUIZ}`), {
                title: "Stale",
                expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
            });
            expectStatus(res, 409);
            expect(res.body?.error?.code === "CONFLICT", `code ${res.body?.error?.code}`);
            expect(
                res.body?.error?.message ===
                    "This item was changed elsewhere. Reload and try again.",
                "wrong message",
            );
        });
        await step(
            "concurrent edits from one version: exactly one wins (compare-and-set)",
            async () => {
                const current = (await a.get(ws(`/artifacts/${state.artifactSUMMARY}`))).body?.data;
                const path = ws(`/artifacts/${state.artifactSUMMARY}`);
                const [one, two] = await Promise.all([
                    a.patch(path, { title: "Race one", expectedUpdatedAt: current.updatedAt }),
                    a.patch(path, { title: "Race two", expectedUpdatedAt: current.updatedAt }),
                ]);
                const statuses = [one.status, two.status].sort();
                expect(
                    statuses[0] === 200 && statuses[1] === 409,
                    `statuses ${statuses.join(", ")}`,
                );
                await a.patch(path, { title: "Renamed summary" });
            },
        );
        await step(
            "MINDMAP edits must keep node ids unique and edges pointing at nodes",
            async () => {
                const path = ws(`/artifacts/${state.artifactMINDMAP}`);
                const mindmap = (await a.get(path)).body?.data;
                const { nodes, edges } = mindmap.content as { nodes: any[]; edges: any[] };

                const dangling = await a.patch(path, {
                    content: {
                        nodes,
                        edges: [...edges, { id: "e-bad", source: nodes[0].id, target: "ghost" }],
                    },
                });
                expectStatus(dangling, 400);
                expect(
                    Object.keys(dangling.body?.error?.details ?? {}).some((k) =>
                        k.startsWith("content.edges."),
                    ),
                    `details ${JSON.stringify(dangling.body?.error?.details)}`,
                );
                expectStatus(
                    await a.patch(path, { content: { nodes: [...nodes, nodes[0]], edges } }),
                    400,
                );
                expectStatus(
                    await a.patch(path, {
                        content: {
                            nodes,
                            edges: [...edges, edges[0] ?? { id: "e1", source: "a", target: "b" }],
                        },
                    }),
                    400,
                );

                const renamed = nodes.map((n, i) => (i === 0 ? { ...n, label: "Edited root" } : n));
                const ok = await a.patch(path, { content: { nodes: renamed, edges } });
                expectStatus(ok, 200);
                expect(
                    ok.body?.data?.content?.nodes?.[0]?.label === "Edited root",
                    "edit not saved",
                );
                expect(ok.body?.data?.metadata?.userEdited === true, "userEdited not set");
            },
        );
        await step(
            "an artifact that is still generating cannot be edited or regenerated (409)",
            async () => {
                const created = await a.post(ws("/artifacts"), { type: "TAKEAWAYS" });
                expectStatus(created, 201);
                const path = ws(`/artifacts/${created.body?.data?.id}`);
                expectStatus(await a.patch(path, { title: "Too early" }), 409);
                expectStatus(await a.post(`${path}/regenerate`, {}), 409);
                await poll(
                    async () => (await a.get(path)).body?.data,
                    (x) => x?.status === "READY" || x?.status === "FAILED",
                    ARTIFACT_TIMEOUT_MS,
                    INNGEST_HINT,
                );
            },
        );
        await step(
            "regenerating an edited artifact needs force (409 ARTIFACT_EDITED)",
            async () => {
                const res = await a.post(ws(`/artifacts/${state.artifactQUIZ}/regenerate`), {});
                expectStatus(res, 409);
                expect(
                    res.body?.error?.code === "ARTIFACT_EDITED",
                    `code ${res.body?.error?.code}`,
                );
                const after = (await a.get(ws(`/artifacts/${state.artifactQUIZ}`))).body?.data;
                expect(after.status === "READY", "a refused regenerate changed the artifact");
                expect(
                    after.content.questions[0].question.startsWith("Edited by the user"),
                    "a refused regenerate discarded the edit",
                );
            },
        );
        await step(
            "regenerate with force: same id and title, 202 PENDING, back to READY, edit flag cleared",
            async () => {
                const path = ws(`/artifacts/${state.artifactQUIZ}`);
                const before = (await a.get(path)).body?.data;
                const res = await a.post(`${path}/regenerate`, { force: true });
                expectStatus(res, 202);
                expect(res.body?.data?.id === state.artifactQUIZ, "id changed");
                expect(res.body?.data?.status === "PENDING", `status ${res.body?.data?.status}`);
                expect(res.body?.data?.title === before.title, "title changed");

                const done = await poll(
                    async () => (await a.get(path)).body?.data,
                    (x) => x?.status === "READY" || x?.status === "FAILED",
                    ARTIFACT_TIMEOUT_MS,
                    INNGEST_HINT,
                );
                expect(done.status === "READY", `ended ${done.status}`);
                expect(
                    done.id === state.artifactQUIZ && done.title === before.title,
                    "id or title changed",
                );
                expect(!done.metadata?.userEdited, "edit flag survived a regenerate");
                expect(
                    !done.content.questions.some((q: any) =>
                        q.question.startsWith("Edited by the user"),
                    ),
                    "edit survived",
                );
                expect(done.content.questions.length >= 3, "no questions");
            },
        );
        await step(
            "regenerate an unedited artifact needs no force and keeps its custom title",
            async () => {
                const path = ws(`/artifacts/${state.artifactSUMMARY}`);
                const res = await a.post(`${path}/regenerate`);
                expectStatus(res, 202);
                expect(res.body?.data?.status === "PENDING", `status ${res.body?.data?.status}`);
                const done = await poll(
                    async () => (await a.get(path)).body?.data,
                    (x) => x?.status === "READY" || x?.status === "FAILED",
                    ARTIFACT_TIMEOUT_MS,
                    INNGEST_HINT,
                );
                expect(done.status === "READY", `ended ${done.status}`);
                expect(done.title === "Renamed summary", `title became "${done.title}"`);
                expect(typeof done.content?.markdown === "string", "no markdown");
            },
        );

        begin("Artifacts");
        await step(
            "artifact list ?q filters by title, case-insensitively, with paging",
            async () => {
                const mindmap = (await a.get(ws(`/artifacts/${state.artifactMINDMAP}`))).body?.data;
                const fragment = (mindmap.title as string).slice(1, 6).toUpperCase();

                const hit = await a.get(ws(`/artifacts?q=${encodeURIComponent(fragment)}`));
                expectStatus(hit, 200);
                expect(
                    (hit.body?.data as any[]).some((x) => x.id === state.artifactMINDMAP),
                    `q=${fragment} did not find "${mindmap.title}"`,
                );
                expect(hit.body?.meta?.total === (hit.body?.data as any[]).length, "meta.total");

                const none = await a.get(ws("/artifacts?q=zzzz-no-such-title"));
                expect(
                    (none.body?.data as any[]).length === 0 && none.body?.meta?.total === 0,
                    "q matched nothing expected",
                );

                const typed = await a.get(
                    ws(`/artifacts?q=${encodeURIComponent(fragment)}&type=QUIZ`),
                );
                expect(
                    !(typed.body?.data as any[]).some((x) => x.id === state.artifactMINDMAP),
                    "type filter ignored next to q",
                );
                const paged = await a.get(ws("/artifacts?q=&limit=1"));
                expectStatus(paged, 200);
                expect(
                    (paged.body?.data as any[]).length === 1,
                    "limit ignored next to an empty q",
                );
            },
        );
        await step("bulk delete artifacts: per-id results, duplicates collapsed", async () => {
            const res = await a.post(ws("/artifacts/bulk-delete"), {
                artifactIds: [
                    state.artifactQUIZ,
                    state.artifactMINDMAP,
                    state.artifactQUIZ,
                    "no-such-artifact",
                ],
            });
            expectStatus(res, 200);
            const { deleted, results } = res.body?.data as { deleted: number; results: any[] };
            expect(results.length === 3, `ids not de-duplicated (${results.length} results)`);
            expect(deleted === 2, `deleted ${deleted}`);
            const statusOf = (id: string) => results.find((r) => r.artifactId === id)?.status;
            expect(statusOf(state.artifactQUIZ) === "deleted", "quiz not deleted");
            expect(statusOf(state.artifactMINDMAP) === "deleted", "mind map not deleted");
            expect(statusOf("no-such-artifact") === "not_found", "unknown id not reported");
            expectStatus(await a.get(ws(`/artifacts/${state.artifactQUIZ}`)), 404);
        });
        await step("artifacts paginate and filter", async () => {
            const all = await a.get(ws("/artifacts"));
            expectStatus(all, 200);
            const total = all.body?.meta?.total as number;
            expect(total === (all.body?.data as any[]).length, "meta.total != list length");
            if (total >= 2) {
                const page = await a.get(ws("/artifacts?limit=1"));
                expect((page.body?.data as any[]).length === 1, "page size not applied");
                expect(typeof page.body?.meta?.nextCursor === "string", "no nextCursor");
            }
            const byType = await a.get(ws("/artifacts?type=QUIZ"));
            expectStatus(byType, 200);
            expect(
                (byType.body?.data as any[]).every((x) => x.type === "QUIZ"),
                "type filter not applied",
            );
            expectStatus(await a.get(ws("/artifacts?status=BOGUS")), 400);
        });
        await step("list and delete artifact", async () => {
            const res = await a.get(ws("/artifacts"));
            expectStatus(res, 200);
            expect((res.body?.data as any[]).length >= 1, "no artifacts listed");
            if (!state.artifactSUMMARY) throw new Skip("no artifact to delete");
            expectStatus(await a.delete(ws(`/artifacts/${state.artifactSUMMARY}`)), 204);
            expectStatus(await a.get(ws(`/artifacts/${state.artifactSUMMARY}`)), 404);
        });
    }

    if (EXTERNAL) {
        begin("External integrations");
        await step("upload PDF, index with page numbers", async () => {
            const form = new FormData();
            form.append("title", "Smoke PDF");
            form.append(
                "file",
                new Blob([buildPdf("Mitochondria are the powerhouse of the cell.")], {
                    type: "application/pdf",
                }),
                "smoke.pdf",
            );
            const res = await a.request("POST", ws("/sources/upload"), { form });
            skipIfNotConfigured(res);
            expectStatus(res, 201);
            if (!AI) return "uploaded (indexing skipped with --no-ai)";
            await waitForSource(a, state.workspaceId, res.body?.data?.id);
            const chunks = await a.get(ws(`/sources/${res.body?.data?.id}/chunks`));
            expect(
                (chunks.body?.data?.chunks as any[]).every((c) => c.metadata?.page === 1),
                "chunk missing page metadata",
            );
        });
        await step("non-PDF bytes named .pdf are rejected", async () => {
            const form = new FormData();
            form.append(
                "file",
                new Blob(["<html>not a pdf</html>"], { type: "application/pdf" }),
                "fake.pdf",
            );
            const res = await a.request("POST", ws("/sources/upload"), { form });
            expectStatus(res, 400);
        });
        await step("import website", async () => {
            const res = await a.post(ws("/sources/import/website"), { url: "https://example.com" });
            skipIfNotConfigured(res);
            expectStatus(res, 201);
            if (AI) await waitForSource(a, state.workspaceId, res.body?.data?.id);
        });
        await step("import YouTube transcript", async () => {
            const res = await a.post(ws("/sources/import/youtube"), {
                url: "https://www.youtube.com/watch?v=aircAruvnKk",
            });
            skipIfNotConfigured(res);
            expectStatus(res, 201);
            if (AI) await waitForSource(a, state.workspaceId, res.body?.data?.id);
        });
        await step("bad YouTube URL is 400", async () => {
            expectStatus(
                await a.post(ws("/sources/import/youtube"), {
                    url: "https://example.com/not-youtube",
                }),
                400,
            );
        });
        await step("import a GitHub repo, indexed per file with paths", async () => {
            const res = await a.post(ws("/sources/import/github"), {
                url: "https://github.com/octocat/Spoon-Knife",
            });
            skipIfNotConfigured(res);
            expectStatus(res, 201);
            expect(res.body?.data?.type === "GITHUB", "source type is not GITHUB");
            expect(res.body?.data?.metadata?.files?.length > 0, "no files in metadata");
            state.githubSourceId = res.body?.data?.id;
            if (!AI) return "imported (indexing skipped with --no-ai)";
            await waitForSource(a, state.workspaceId, state.githubSourceId);
            const chunks = await a.get(ws(`/sources/${state.githubSourceId}/chunks`));
            expect(
                (chunks.body?.data?.chunks as any[]).every(
                    (c) => typeof c.metadata?.path === "string",
                ),
                "chunk missing path metadata",
            );
        });
        await step("GitHub repo files list shows chunk counts", async () => {
            if (!state.githubSourceId) throw new Skip("no GitHub source");
            const res = await a.get(ws(`/sources/${state.githubSourceId}/files`));
            expectStatus(res, 200);
            const files = res.body?.data?.files as any[];
            expect(files.length > 0, "no files listed");
            expect(typeof res.body?.data?.commitSha === "string", "missing commitSha");
            if (AI)
                expect(
                    files.some((f) => f.chunkCount > 0),
                    "no file has chunks",
                );
        });
        await step("importing the same repo again is 409", async () => {
            if (!state.githubSourceId) throw new Skip("no GitHub source");
            expectStatus(
                await a.post(ws("/sources/import/github"), { url: "octocat/Spoon-Knife" }),
                409,
            );
        });
        await step("a bad repo string is 400", async () => {
            expectStatus(await a.post(ws("/sources/import/github"), { url: "not-a-repo" }), 400);
        });
        await step("sync is a no-op when the repo has not changed", async () => {
            if (!state.githubSourceId) throw new Skip("no GitHub source");
            if (AI) await waitForSource(a, state.workspaceId, state.githubSourceId);
            else await sleep(1_000);
            const res = await a.post(ws(`/sources/${state.githubSourceId}/sync`));
            // Without AI the source may still be PENDING (409); only assert once it is settled.
            if (!AI && res.status === 409) throw new Skip("still processing (--no-ai)");
            expectStatus(res, 202);
            expect(res.body?.data?.changed === false, "expected changed: false");
        });
        await step("syncing a non-GitHub source is 400", async () => {
            expectStatus(await a.post(ws(`/sources/${state.textSourceId}/sync`)), 400);
        });
        if (AI) {
            await step("chat about the repo cites file paths", async () => {
                if (!state.githubSourceId) throw new Skip("no GitHub source");
                const res = await a.post(ws("/chat"), {
                    messages: [userMessage("Which files are in the Spoon-Knife repository?")],
                });
                expectStatus(res, 200);
                const reply = readChatStream(res.text);
                expect(reply.length > 0, "empty reply");
                const conversationId = res.headers.get("x-conversation-id") ?? "";
                const messages = await a.get(ws(`/conversations/${conversationId}/messages`));
                const cited = (messages.body?.data as any[])
                    .filter((m) => m.role === "ASSISTANT")
                    .flatMap((m) => (m.citations ?? []) as any[]);
                expect(
                    cited.some((c) => typeof c.path === "string"),
                    "no citation carries a file path",
                );
            });
            await step("generate WIKI to READY", async () => {
                if (!state.githubSourceId) throw new Skip("no GitHub source");
                const created = await a.post(ws("/artifacts"), {
                    type: "WIKI",
                    sourceIds: [state.githubSourceId],
                });
                expectStatus(created, 201);
                const id = created.body?.data?.id as string;
                const artifact = await poll(
                    async () => (await a.get(ws(`/artifacts/${id}`))).body?.data,
                    (x) => x?.status === "READY" || x?.status === "FAILED",
                    ARTIFACT_TIMEOUT_MS,
                    INNGEST_HINT,
                );
                expect(artifact.status === "READY", `wiki ended ${artifact.status}`);
                expect(typeof artifact.content?.overview === "string", "wiki has no overview");
                expect(artifact.content?.modules?.length > 0, "wiki has no modules");
                expect(
                    typeof artifact.content?.diagram === "string" &&
                        !artifact.content.diagram.includes("```"),
                    "wiki diagram missing or fenced",
                );
            });
        }
        await step("import a web search result as a source", async () => {
            const res = await a.post(ws("/sources/import/web-search"), {
                title: "Chlorophyll (web result)",
                content: "Chlorophyll absorbs mostly blue and red light and reflects green.",
                url: "https://example.com/chlorophyll",
            });
            expectStatus(res, 201);
        });
        if (AI) {
            await step("chat with webSearch: true", async () => {
                const res = await a.post(ws("/chat"), {
                    webSearch: true,
                    messages: [
                        userMessage(
                            "What is the latest research news about photosynthesis this year?",
                        ),
                    ],
                });
                expectStatus(res, 200);
                expect(readChatStream(res.text).length > 0, "empty reply");
            });
        }
    }

    begin("Cleanup");
    await step("bulk delete sources", async () => {
        if (KEEP) throw new Skip("--keep");
        const res = await a.post(ws("/sources/bulk-delete"), {
            sourceIds: [state.markdownSourceId, state.markdownSourceId, "no-such-source"],
        });
        expectStatus(res, 200);
        const { deleted, results } = res.body?.data as {
            deleted: number;
            results: { sourceId: string; status: string }[];
        };
        expect(results.length === 2, `ids not de-duplicated (${results.length} results)`);
        expect(deleted === 1, `deleted ${deleted}`);
        expect(
            results.find((r) => r.sourceId === "no-such-source")?.status === "not_found",
            "unknown id not reported",
        );
        expectStatus(await a.get(ws(`/sources/${state.markdownSourceId}`)), 404);
    });
    await step("delete workspaces", async () => {
        if (KEEP) throw new Skip(`--keep (workspace ${state.workspaceId})`);
        for (const id of [state.workspaceId, state.emptyWorkspaceId, state.editWorkspaceId].filter(
            Boolean,
        )) {
            expectStatus(await a.delete(`/api/workspaces/${id}`), 204);
            expectStatus(await a.get(`/api/workspaces/${id}`), 404);
        }
    });
    await step("sign out", async () => {
        expectStatus(await a.post("/api/auth/sign-out"), 200);
        expectStatus(await a.get("/api/me"), 401);
    });

    const count = (status: Result["status"]) => results.filter((r) => r.status === status).length;
    const failed = results.filter((r) => r.status === "FAIL");
    console.log(
        `\n\x1b[1mResult:\x1b[0m \x1b[32m${count("PASS")} passed\x1b[0m, \x1b[31m${count("FAIL")} failed\x1b[0m, \x1b[33m${count("SKIP")} skipped\x1b[0m`,
    );
    for (const r of failed) console.log(`  \x1b[31m✘\x1b[0m [${r.section}] ${r.name}: ${r.detail}`);
    console.log(
        `\x1b[2m${requestCount} requests sent (the API allows 300 per 15 minutes per IP; wait before re-running if you are close)\x1b[0m`,
    );
    console.log(`\x1b[2mTest users (not deleted): ${userA.email}, ${userB.email}\x1b[0m`);
    process.exit(failed.length > 0 ? 1 : 0);
}

void main();
