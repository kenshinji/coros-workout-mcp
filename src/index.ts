#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { writeFileSync } from "node:fs";
import { loadDotEnv } from "./dotenv.js";
import { setAuthStore } from "./auth-store.js";
import { fileAuthStore } from "./auth-store-node.js";
import { createServer } from "./mcp-server.js";
import { getCatalogPath, reloadCatalog } from "./exercise-catalog.js";

// Pick up COROS_EMAIL / COROS_PASSWORD / COROS_REGION from a .env file at the
// project root. Must run before any tool reads process.env.
loadDotEnv();

setAuthStore(fileAuthStore);

const server = createServer({
  async saveCatalog(catalog) {
    const catalogPath = getCatalogPath();
    writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
    reloadCatalog();
    return catalogPath;
  },
});

// --- Start server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});
