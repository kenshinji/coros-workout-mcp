/**
 * Cloudflare Worker entry point — the same MCP server as `index.ts`, but over
 * Streamable HTTP so it can be added to claude.ai (and Claude Desktop/mobile)
 * as a custom connector instead of running on one laptop.
 *
 * Two things a Worker doesn't have: a filesystem and a long-lived process. So
 * the access token goes to KV, and the exercise catalog is bundled into the
 * script (with a KV copy taking precedence once `update_exercises` writes one).
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import bundledCatalog from "../data/exercises.json";
import { createServer } from "./mcp-server.js";
import { setAuthStore, type AuthStore } from "./auth-store.js";
import { setCatalog } from "./exercise-catalog.js";
import type { AuthData, CatalogExercise } from "./types.js";

export interface Env {
  /** KV namespace holding the COROS token and any updated catalog. */
  COROS_KV: KVNamespace;
  /** Shared secret guarding the endpoint. Without it the Worker serves nothing. */
  MCP_SECRET?: string;
  COROS_EMAIL?: string;
  COROS_PASSWORD?: string;
  COROS_REGION?: string;
}

const AUTH_KEY = "coros-auth";
const CATALOG_KEY = "exercise-catalog";
/** Small key that says a catalog override exists, so the big one is only read when it does. */
const CATALOG_STAMP_KEY = "exercise-catalog-updated-at";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Expose-Headers": "mcp-session-id",
};

function kvAuthStore(kv: KVNamespace): AuthStore {
  return {
    async load() {
      return (await kv.get<AuthData>(AUTH_KEY, "json")) ?? null;
    },
    async save(auth) {
      await kv.put(AUTH_KEY, JSON.stringify(auth));
    },
  };
}

/**
 * The COROS client reads credentials from process.env; on Workers they arrive
 * as bindings. Copying them over keeps that code identical on both hosts.
 */
function applyCredentials(env: Env): void {
  for (const key of ["COROS_EMAIL", "COROS_PASSWORD", "COROS_REGION"] as const) {
    const value = env[key];
    if (value) process.env[key] = value;
  }
}

let catalogInstalled = false;

async function installCatalog(env: Env): Promise<void> {
  if (catalogInstalled) return;
  let catalog = bundledCatalog as CatalogExercise[];
  try {
    if (await env.COROS_KV.get(CATALOG_STAMP_KEY)) {
      const stored = await env.COROS_KV.get<CatalogExercise[]>(CATALOG_KEY, "json");
      if (stored && stored.length > 0) catalog = stored;
    }
  } catch {
    // KV unreachable — the bundled catalog is still perfectly usable
  }
  setCatalog(catalog);
  catalogInstalled = true;
}

function secretMatches(candidate: string, secret: string): boolean {
  if (candidate.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) {
    diff |= candidate.charCodeAt(i) ^ secret.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * The secret can arrive as a bearer token or as the last path segment —
 * claude.ai's connector UI takes a URL but no custom headers.
 */
function isAuthorized(request: Request, url: URL, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  if (/^bearer /i.test(header) && secretMatches(header.slice(7).trim(), secret)) {
    return true;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  return parts.length === 2 && parts[0] === "mcp" && secretMatches(parts[1], secret);
}

function isMcpPath(url: URL): boolean {
  const parts = url.pathname.split("/").filter(Boolean);
  return parts[0] === "mcp" && parts.length <= 2;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (!isMcpPath(url)) {
      return new Response("coros-workout-mcp: POST /mcp/<secret> to talk MCP.\n", {
        status: url.pathname === "/" ? 200 : 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (!env.MCP_SECRET) {
      return new Response(
        "MCP_SECRET is not set. Run: wrangler secret put MCP_SECRET\n",
        { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }

    if (!isAuthorized(request, url, env.MCP_SECRET)) {
      return new Response("Not found\n", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    applyCredentials(env);
    setAuthStore(kvAuthStore(env.COROS_KV));
    await installCatalog(env);

    const server = createServer({
      async saveCatalog(catalog) {
        await env.COROS_KV.put(CATALOG_KEY, JSON.stringify(catalog));
        await env.COROS_KV.put(CATALOG_STAMP_KEY, new Date().toISOString());
        setCatalog(catalog);
        return "Cloudflare KV";
      },
    });

    // Stateless: a fresh server and transport per request, since no isolate is
    // guaranteed to survive between them.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);

    // The spec says a client must accept both application/json and
    // text/event-stream, and the SDK answers 406 when it doesn't. Some hosts
    // send only application/json; since `enableJsonResponse` means the reply is
    // JSON either way, widen the header rather than fail the call.
    const accept = request.headers.get("accept") ?? "";
    let normalized = request;
    if (!accept.includes("text/event-stream") || !accept.includes("application/json")) {
      const headers = new Headers(request.headers);
      headers.set("accept", "application/json, text/event-stream");
      normalized = new Request(request, { headers });
    }

    let parsedBody: unknown;
    if (request.method === "POST") {
      parsedBody = await normalized.clone().json();
    }
    console.log(
      JSON.stringify({
        method: request.method,
        rpc: (parsedBody as { method?: string } | undefined)?.method,
        accept,
        ua: request.headers.get("user-agent"),
        protocolVersion: request.headers.get("mcp-protocol-version"),
      })
    );

    const response = await transport.handleRequest(
      normalized,
      parsedBody === undefined ? undefined : { parsedBody }
    );
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
