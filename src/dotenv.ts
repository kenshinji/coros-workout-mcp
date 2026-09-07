import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Load KEY=VALUE pairs from a .env file next to package.json, without adding a
 * dependency. Real environment variables win, so an MCP host's `env` block
 * still overrides the file.
 */
export function loadDotEnv(startDir: string = new URL(".", import.meta.url).pathname): void {
  let dir = resolve(startDir);
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(dir, ".env");
    let text: string;
    try {
      text = readFileSync(candidate, "utf-8");
    } catch {
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
    return;
  }
}
