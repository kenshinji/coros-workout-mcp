import type { AuthData } from "./types.js";

/**
 * Where the COROS access token lives between calls. The stdio server keeps it
 * in a file under ~/.config; the Cloudflare Worker keeps it in KV, since a
 * Worker has no writable disk and no isolate is guaranteed to outlive a
 * request. Everything else in the server just asks the store.
 */
export interface AuthStore {
  load(): Promise<AuthData | null>;
  save(auth: AuthData): Promise<void>;
}

/** Default store: the token lives only as long as the process. */
let memory: AuthData | null = null;
let store: AuthStore = {
  async load() {
    return memory;
  },
  async save(auth) {
    memory = auth;
  },
};

export function setAuthStore(next: AuthStore): void {
  store = next;
}

export function getAuthStore(): AuthStore {
  return store;
}
