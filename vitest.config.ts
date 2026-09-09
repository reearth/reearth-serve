import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    "import.meta.vitest": "undefined",
  },
  test: {
    // The repository layer is tested against `node:sqlite`
    // (worker/infra/sqlite-node.ts). Node 22 — the version CI runs — only
    // exposes that module behind a flag; Node 24+ accepts the flag as a no-op,
    // so one setting covers both.
    poolOptions: {
      forks: { execArgv: ["--experimental-sqlite"] },
      threads: { execArgv: ["--experimental-sqlite"] },
    },
    projects: [
      {
        test: {
          name: "unit",
          includeSource: ["worker/**/*.ts"],
          exclude: ["e2e/**", "node_modules/**"],
        },
      },
      {
        test: {
          name: "e2e",
          include: ["e2e/**/*.test.ts"],
          testTimeout: 15000,
          hookTimeout: 10000,
        },
      },
    ],
  },
});
