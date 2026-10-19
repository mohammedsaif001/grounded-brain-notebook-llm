/**
 * OpenAI clients configured from validated env.
 *
 * - `openai`: AI SDK provider for chat/generation (`openai(CHAT_MODEL)`)
 * - `openaiClient`: OpenAI SDK client (used for embeddings in `lib/rag/embeddings.ts`)
 */

import OpenAI from "openai";
import { createOpenAI } from "@ai-sdk/openai";
import { env } from "./env.js";

/** AI SDK OpenAI provider; use instead of the default `openai` export so the key comes from `env`. */
export const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });

/** Raw OpenAI SDK client. */
export const openaiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY });
