#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

try {
  execFileSync("npx", ["tsx", join(__dirname, "..", "cli", "index.ts"), ...args], {
    stdio: "inherit",
    cwd: join(__dirname, ".."),
  });
} catch (e) {
  process.exit(e.status ?? 1);
}
