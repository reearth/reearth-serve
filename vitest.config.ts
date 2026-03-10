import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    "import.meta.vitest": "undefined",
  },
  test: {
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
