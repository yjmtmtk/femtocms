import { defineConfig } from "vitest/config";

// Vitest 4 replaced vitest.workspace.ts with `test.projects`.
export default defineConfig({
  test: {
    projects: [
      "worker/vitest.config.ts",
      {
        test: {
          name: "node",
          environment: "node",
          include: ["cli/test/**/*.test.ts", "worker/test-dom/**/*.test.ts"],
        },
      },
    ],
  },
});
