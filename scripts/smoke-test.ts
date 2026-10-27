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

/** Delay between status polls. */
const POLL_INTERVAL_MS = 2_000;
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
                } else {
                    const questions = artifact.content?.questions as any[];
                    expect(questions?.length > 0, "quiz has no questions");
                    expect(
                        questions.every(
                            (q) => q.correctIndex >= 0 && q.correctIndex < q.options.length,
                        ),
                        "correctIndex out of range",
                    );
                }
                state[`artifact${type}`] = id;
            });
        }
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
        expectStatus(
            await a.post(ws("/sources/bulk-delete"), { sourceIds: [state.markdownSourceId] }),
            204,
        );
        expectStatus(await a.get(ws(`/sources/${state.markdownSourceId}`)), 404);
    });
    await step("delete workspaces", async () => {
        if (KEEP) throw new Skip(`--keep (workspace ${state.workspaceId})`);
        for (const id of [state.workspaceId, state.emptyWorkspaceId].filter(Boolean)) {
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
    console.log(`\x1b[2mTest users (not deleted): ${userA.email}, ${userB.email}\x1b[0m`);
    process.exit(failed.length > 0 ? 1 : 0);
}

void main();
