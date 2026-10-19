// ESLint flat config: TypeScript type-aware rules for src/, Prettier owns formatting.
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
    {
        ignores: ["dist/**", "node_modules/**", "src/generated/**"],
    },

    js.configs.recommended,
    tseslint.configs.recommendedTypeChecked,

    {
        languageOptions: {
            globals: globals.node,
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // `_`-prefixed params/vars are intentionally unused (e.g. Express `_req`).
            "@typescript-eslint/no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
            ],
            // Prefer `import type` for type-only imports.
            "@typescript-eslint/consistent-type-imports": [
                "error",
                { fixStyle: "inline-type-imports" },
            ],
            // Express handlers are async; allow passing them where a void callback is expected.
            "@typescript-eslint/no-misused-promises": [
                "error",
                { checksVoidReturn: { arguments: false, attributes: false } },
            ],
        },
    },

    // Config files outside the TypeScript project: lint without type information.
    {
        files: ["*.js", "*.config.ts", "prisma7.config.ts"],
        extends: [tseslint.configs.disableTypeChecked],
    },

    // Must be last: turns off rules that would fight Prettier's formatting.
    prettier,
);
