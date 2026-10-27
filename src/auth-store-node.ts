import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { AuthStore } from "./auth-store.js";
import type { AuthData } from "./types.js";

const CONFIG_DIR = resolve(homedir(), ".config", "coros-workout-mcp");
export const AUTH_FILE = resolve(CONFIG_DIR, "auth.json");

/** Token storage for the stdio server: ~/.config/coros-workout-mcp/auth.json */
export const fileAuthStore: AuthStore = {
  async load(): Promise<AuthData | null> {
    try {
      return JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    } catch {
      return null;
    }
  },
  async save(auth: AuthData): Promise<void> {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(AUTH_FILE, JSON.stringify(auth), { mode: 0o600 });
  },
};
