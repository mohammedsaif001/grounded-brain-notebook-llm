/**
 * Reads a GitHub repository into a single text source (GITHUB source imports).
 *
 * A repository becomes ONE source: its text files are packed into `source.content` with
 * a marker line before each file, and unpacked again at chunking time so every chunk
 * can carry the `path` of the file it came from.
 */

import { GithubClient } from "../../../config/github.js";
import { APIError } from "../../../shared/http/api-error.js";

/** Most files read from one repository. */
const MAX_FILES = 200;

/** Files larger than this (bytes) are skipped. */
const MAX_FILE_BYTES = 200_000;

/** Cap on the packed text of one repository, so `source.content` stays a sane size. */
const MAX_TOTAL_CHARS = 2_000_000;

/** Files fetched in parallel. */
const FETCH_CONCURRENCY = 8;

/** Directories that never contain useful source text. */
const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    ".github",
    "dist",
    "build",
    "out",
    "coverage",
    ".next",
    "vendor",
    "target",
    "__pycache__",
    ".gradle",
    ".vscode",
    ".idea",
    "bin",
    "obj",
    ".turbo",
    ".cache",
]);

/** Binary and generated file extensions that are never indexed. */
const SKIP_EXTENSIONS = new Set([
    "png",
    "jpg",
    "jpeg",
    "gif",
    "svg",
    "ico",
    "webp",
    "bmp",
    "woff",
    "woff2",
    "ttf",
    "eot",
    "otf",
    "mp3",
    "mp4",
    "mov",
    "wav",
    "webm",
    "exe",
    "dll",
    "so",
    "dylib",
    "bin",
    "wasm",
    "class",
    "jar",
    "war",
    "ear",
    "zip",
    "tar",
    "gz",
    "tgz",
    "7z",
    "rar",
    "pdf",
    "lock",
    "map",
    "pyc",
    "sqlite",
    "db",
]);

/** Lockfiles and OS junk. */
const SKIP_FILES = new Set([
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.lock",
    "composer.lock",
    "go.sum",
    ".DS_Store",
    "Thumbs.db",
]);

/** Files that explain a project best; read first so truncation never drops them. */
const PRIORITY_FILES = /^(readme|package\.json|pyproject\.toml|go\.mod|cargo\.toml|pom\.xml)/i;

/** Marks the start of a file inside the packed repository text. */
const FILE_MARKER = /^===== FILE: (.+) =====$/;

/** One text file read from a repository. */
export type RepoFile = {
    path: string;
    content: string;
};

/** Everything read from one repository. */
export type RepoSnapshot = {
    owner: string;
    repo: string;
    branch: string;
    commitSha: string;
    description: string | null;
    files: RepoFile[];
    /** Text files found before the file and size caps were applied. */
    totalFiles: number;
    /** True when files were dropped because of the file or size caps. */
    truncated: boolean;
};

/**
 * Whether a tree entry should be skipped (vendored, binary, generated or too large).
 *
 * @param path - Path within the repository
 * @param size - File size in bytes, when GitHub reports it
 */
function shouldSkip(path: string, size?: number) {
    const parts = path.split("/");
    const fileName = parts[parts.length - 1];

    if (parts.some((part) => SKIP_DIRS.has(part))) return true;
    if (SKIP_FILES.has(fileName)) return true;
    if (typeof size === "number" && size > MAX_FILE_BYTES) return true;

    const dot = fileName.lastIndexOf(".");
    const extension = dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();

    return (
        SKIP_EXTENSIONS.has(extension) ||
        fileName.endsWith(".min.js") ||
        fileName.endsWith(".min.css")
    );
}

/**
 * Orders paths so overview files and shallow files come first.
 *
 * @param a - First path
 * @param b - Second path
 */
function byImportance(a: string, b: string) {
    const nameA = a.split("/").pop() ?? a;
    const nameB = b.split("/").pop() ?? b;
    const priorityA = PRIORITY_FILES.test(nameA) ? 0 : 1;
    const priorityB = PRIORITY_FILES.test(nameB) ? 0 : 1;

    if (priorityA !== priorityB) return priorityA - priorityB;

    const depth = a.split("/").length - b.split("/").length;
    return depth !== 0 ? depth : a.localeCompare(b);
}

/**
 * Turns a thrown Octokit error into a client-facing {@link APIError}.
 *
 * @param error - Error thrown by Octokit
 * @param owner - Repository owner (for the message)
 * @param repo - Repository name (for the message)
 */
function toApiError(error: unknown, owner: string, repo: string) {
    const status = (error as { status?: number }).status;
    const message = error instanceof Error ? error.message : "";

    if (status === 404) {
        return APIError.NotFound(
            `GitHub repository "${owner}/${repo}" was not found, or it is private and the server token cannot read it`,
        );
    }
    if (status === 401) {
        return APIError.ServiceUnavailable("The server's GitHub token is invalid");
    }
    if (status === 403 || status === 429) {
        return APIError.ServiceUnavailable(
            message.toLowerCase().includes("rate limit")
                ? "GitHub rate limit reached. Try again later."
                : "GitHub refused the request",
        );
    }

    return APIError.BadRequest("Could not read this GitHub repository");
}

/** Reads GitHub repositories and converts them to and from a packed text form. */
export class GithubRepoClient {
    /**
     * Parses `owner/repo`, a GitHub URL or an SSH remote into its parts.
     *
     * @param input - e.g. `owner/repo`, `https://github.com/owner/repo(.git)`, `git@github.com:owner/repo.git`
     * @returns Owner and repository name
     * @throws {APIError} BadRequest when the input has no owner and repository
     */
    static parseRepo(input: string) {
        const cleaned = input
            .trim()
            .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
            .replace(/^git@github\.com:/i, "")
            .replace(/\.git$/i, "")
            .replace(/^\/+|\/+$/g, "");

        const [owner, repo] = cleaned.split("/").filter(Boolean);

        if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
            throw APIError.BadRequest('Enter "owner/repo" or a GitHub repository URL');
        }

        return { owner, repo };
    }

    /**
     * Returns the commit a branch currently points to (one cheap API call), used to
     * detect whether a repository changed since it was imported.
     *
     * @param owner - Repository owner
     * @param repo - Repository name
     * @param branch - Branch to check; defaults to the repository's default branch
     * @throws {APIError} NotFound / ServiceUnavailable / BadRequest when GitHub rejects the call
     */
    static async getHead(owner: string, repo: string, branch?: string) {
        const octokit = GithubClient.get();

        try {
            const resolvedBranch =
                branch ?? (await octokit.rest.repos.get({ owner, repo })).data.default_branch;
            const { data } = await octokit.rest.repos.getBranch({
                owner,
                repo,
                branch: resolvedBranch,
            });

            return { branch: resolvedBranch, commitSha: data.commit.sha };
        } catch (error) {
            throw toApiError(error, owner, repo);
        }
    }

    /**
     * Reads a repository's text files, skipping vendored, binary, generated and oversized
     * files, and stopping at {@link MAX_FILES} files or {@link MAX_TOTAL_CHARS} characters.
     * Overview files (README, manifests) and shallow files are read first.
     *
     * @param owner - Repository owner
     * @param repo - Repository name
     * @param branch - Branch to read; defaults to the repository's default branch
     * @returns The repository's files plus the commit they were read at
     * @throws {APIError} BadRequest when the repository has no readable text files
     */
    static async fetchRepo(owner: string, repo: string, branch?: string): Promise<RepoSnapshot> {
        const octokit = GithubClient.get();

        let info;
        let commitSha: string;
        let tree;

        try {
            info = (await octokit.rest.repos.get({ owner, repo })).data;
            const head = await this.getHead(owner, repo, branch ?? info.default_branch);
            commitSha = head.commitSha;
            tree = (
                await octokit.rest.git.getTree({
                    owner,
                    repo,
                    tree_sha: commitSha,
                    recursive: "true",
                })
            ).data;
        } catch (error) {
            throw error instanceof APIError ? error : toApiError(error, owner, repo);
        }

        const candidates = tree.tree
            .filter(
                (item) =>
                    item.type === "blob" &&
                    item.path &&
                    item.sha &&
                    !shouldSkip(item.path, item.size),
            )
            .sort((a, b) => byImportance(a.path, b.path));

        const wanted = candidates.slice(0, MAX_FILES);
        const files: RepoFile[] = [];
        let totalChars = 0;
        let truncated = tree.truncated === true || candidates.length > wanted.length;
        let overBudget = false;

        for (let i = 0; i < wanted.length && !overBudget; i += FETCH_CONCURRENCY) {
            const batch = wanted.slice(i, i + FETCH_CONCURRENCY);
            const results = await Promise.all(
                batch.map(async (item) => {
                    try {
                        const { data } = await octokit.rest.git.getBlob({
                            owner,
                            repo,
                            file_sha: item.sha,
                        });
                        const content =
                            data.encoding === "base64"
                                ? Buffer.from(data.content, "base64").toString("utf8")
                                : data.content;

                        // Binary files that slipped past the extension list.
                        if (content.includes("\u0000") || !content.trim()) {
                            return null;
                        }

                        return { path: item.path, content };
                    } catch {
                        // One unreadable file should not fail the whole import.
                        return null;
                    }
                }),
            );

            for (const file of results) {
                if (!file) continue;
                if (totalChars + file.content.length > MAX_TOTAL_CHARS) {
                    truncated = true;
                    overBudget = true;
                    break;
                }
                totalChars += file.content.length;
                files.push(file);
            }
        }

        if (files.length === 0) {
            throw APIError.BadRequest("This repository has no readable text files");
        }

        return {
            owner,
            repo,
            branch: branch ?? info.default_branch,
            commitSha,
            description: info.description,
            files,
            totalFiles: candidates.length,
            truncated,
        };
    }

    /**
     * Packs files into the single text stored on the source, one marker line per file.
     *
     * @param files - Files to pack
     * @returns Text that {@link GithubRepoClient.unpack} turns back into the same files
     */
    static pack(files: RepoFile[]) {
        return files.map((file) => `===== FILE: ${file.path} =====\n${file.content}`).join("\n\n");
    }

    /**
     * Splits packed repository text back into its files.
     *
     * @param packed - Text produced by {@link GithubRepoClient.pack}
     * @returns Files in their original order; empty when no markers are found
     */
    static unpack(packed: string): RepoFile[] {
        const files: RepoFile[] = [];
        let current: { path: string; lines: string[] } | null = null;

        const flush = () => {
            const content = current?.lines.join("\n").trim();
            if (current && content) {
                files.push({ path: current.path, content });
            }
        };

        for (const line of packed.split("\n")) {
            const path = FILE_MARKER.exec(line)?.[1];
            if (path) {
                flush();
                current = { path, lines: [] };
            } else {
                current?.lines.push(line);
            }
        }
        flush();

        return files;
    }

    /**
     * Renders file paths as an indented tree for prompts (directories first, sorted).
     *
     * @param paths - File paths within the repository
     * @param maxChars - Output is cut at this length, with a note
     */
    static renderTree(paths: string[], maxChars = 6_000) {
        const root: Record<string, unknown> = {};

        for (const path of paths) {
            let node = root;
            for (const part of path.split("/")) {
                node = (node[part] ??= {}) as Record<string, unknown>;
            }
        }

        const lines: string[] = [];
        const walk = (node: Record<string, unknown>, depth: number) => {
            const entries = Object.entries(node).sort(([nameA, a], [nameB, b]) => {
                const dirA = Object.keys(a as object).length > 0;
                const dirB = Object.keys(b as object).length > 0;
                return dirA === dirB ? nameA.localeCompare(nameB) : dirA ? -1 : 1;
            });

            for (const [name, child] of entries) {
                const isDir = Object.keys(child as object).length > 0;
                lines.push(`${"  ".repeat(depth)}${name}${isDir ? "/" : ""}`);
                if (isDir) walk(child as Record<string, unknown>, depth + 1);
            }
        };
        walk(root, 0);

        const tree = lines.join("\n");
        return tree.length > maxChars ? `${tree.slice(0, maxChars)}\n… (tree truncated)` : tree;
    }
}
