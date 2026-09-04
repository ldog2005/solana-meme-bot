import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], environment: "node", testTimeout: 20000, env: { DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" } },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
