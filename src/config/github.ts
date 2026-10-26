/**
 * GitHub (Octokit) client.
 *
 * Only the connection lives here; repository reads go through {@link GithubRepoClient}
 * in `features/source/ingestion/github.ts`.
 */

import { Octokit } from "@octokit/rest";
import { env } from "./env.js";

/** Lazily created singleton accessor for the Octokit client. */
export class GithubClient {
    private static client: Octokit | null = null;

    /**
     * Returns the singleton Octokit client.
     *
     * Authenticated when `GITHUB_TOKEN` is set; otherwise anonymous, which only reaches
     * public repositories and is limited to 60 requests per hour.
     */
    static get() {
        if (!this.client) {
            this.client = new Octokit(env.GITHUB_TOKEN ? { auth: env.GITHUB_TOKEN } : {});
        }

        return this.client;
    }
}
