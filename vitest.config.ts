import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    allowOnly: false,
    passWithNoTests: false,
    include: ["tests/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "**/*.d.ts",
        "**/types.ts",
        "**/index.ts",
        "src/cli.ts",
        "src/core/ports.ts",
        "src/sources/kind.ts",
        "web/src/**",
      ],
      reporter: ["text", "json-summary"],
    },
  },
});
