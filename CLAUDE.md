# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

MCP server that lets Claude design strength workouts and push them to a COROS watch via the reverse-engineered COROS Training Hub API. This is an unofficial project — the API is undocumented and may change without notice.

## Build & Test

```bash
npm install && npm run build   # TypeScript → dist/
npm test                       # vitest (unit tests only, no API calls)
npm run test:watch             # vitest watch mode
```

```bash
npm run typecheck:worker       # tsc --noEmit over the Worker (wrangler itself skips type checking)
npm run dev:worker             # wrangler dev, needs .dev.vars with MCP_SECRET
npm run deploy                 # wrangler deploy
```

Build output goes to `dist/` via `tsc`. The server entry point is `dist/src/index.ts` (compiled to `dist/src/index.js`). `src/worker.ts` is excluded from `tsconfig.json` on purpose — including it makes `tsc` copy the 1.3 MB catalog JSON into `dist/`.

To run a single test file: `npx vitest run src/__tests__/exercise-catalog.test.ts`

## Architecture

**Two entry points, one server:**

- `index.ts` — stdio entry. Loads `.env`, installs the file-backed auth store, builds the server via `createServer()`, connects `StdioServerTransport`.
- `worker.ts` — Cloudflare Worker entry (bundled by wrangler, excluded from the `tsc` build). Same server over `WebStandardStreamableHTTPServerTransport`, stateless (a fresh server + transport per request). Guards the endpoint with `MCP_SECRET` (bearer token or last path segment), copies binding secrets into `process.env`, installs the KV auth store, and hands the bundled `data/exercises.json` to `setCatalog()`.
- `mcp-server.ts` — `createServer()`: registers the 9 tools (`authenticate_coros`, `check_coros_auth`, `search_exercises`, `create_workout`, `create_run_workout`, `schedule_workout`, `list_scheduled_workouts`, `update_exercises`, `list_workouts`) using `@modelcontextprotocol/sdk`. `update_exercises` is only registered when the host passes a `saveCatalog` callback (file on disk / KV).
- `auth-store.ts` — the `AuthStore` interface plus the process-memory default; `setAuthStore()` swaps in a host-specific one. `auth-store-node.ts` is the `~/.config/coros-workout-mcp/auth.json` implementation (the only place that touches `node:fs` for auth).
- `dotenv.ts` — `loadDotEnv()`, kept out of `coros-api.ts` so the Worker bundle doesn't pull in `node:fs`.
- `coros-api.ts` — COROS API client + payload construction. Handles auth (MD5 password hashing, token read/write through the auth store), and the workout creation flow: `resolveExercises()` → `calculateWorkout()` (POST `/training/program/calculate`) → `addWorkout()` (POST `/training/program/add`). Also contains `buildCatalogFromRaw()` for the `update_exercises` tool.
- `exercise-catalog.ts` — In-memory exercise search engine. Loads `data/exercises.json` lazily, provides `findByName()` (exact, case-insensitive), `searchExercises()` (fuzzy name + muscle/bodyPart/equipment filters). The catalog is the single source of truth for exercise names used in `create_workout`.
- `run-workout.ts` — Running workouts (`sportType: 1`). Builds the segment array from a `RunStep[]` tree (`buildRunExercises()`) and the workout envelope (`buildRunWorkoutPayload()`). Running has no exercise catalog — every segment is one of four fixed COROS templates in `RUN_SEGMENT_TEMPLATES`.
- `types.ts` — All interfaces and enum maps. Numeric code → human-readable name mappings for muscles, body parts, equipment. Key types: `CatalogExercise` (bundled catalog), `ExercisePayload` (API payload), `ExerciseOverrides` (user input), `RawExercise` (API response).

**Data flow for run workout creation:**
User provides steps (warmup/work/recovery/cooldown, plus `repeat` groups) → `buildRunExercises()` flattens the tree and encodes targets/paces → POST to `/calculate` (returns `plan*` fields, server expands repeats) → POST to `/add` to save.

**Data flow for strength workout creation:**
User provides exercise names + overrides → `findByName()` validates against catalog → `buildExercisePayload()` merges catalog defaults with overrides → `buildWorkoutPayload()` wraps exercises → POST to `/calculate` for metrics → POST to `/add` to save.

## Key Conventions

- All exercises use numeric IDs internally (muscle, part, equipment, targetType, intensityType). The enum maps in `types.ts` handle code↔name translation.
- `targetType`: 2=duration (seconds), 3=reps. `intensityType`: 0=none, 1=weight (in grams internally, kg in user-facing API).
- Exercise names in `create_workout` must match `data/exercises.json` exactly (case-insensitive). The `search_exercises` tool helps users find correct names.
- API auth requires `accesstoken` header + `yfheader` JSON with `userId`. Logging in via API invalidates the COROS web app session, and vice versa.
- `loadDotEnv()` (called at startup in `index.ts`, from `dotenv.ts`) reads `.env` from the project root without a dependency; already-set env vars take precedence. Credentials are never required at build time. The Worker has no `.env` — `worker.ts` copies its bindings into `process.env` instead.
- Anything host-specific (filesystem, token storage) must stay out of `coros-api.ts`, `mcp-server.ts` and `exercise-catalog.ts`: those three run unchanged on Node and in workerd.
- `apiGet`/`apiPost` retry once on result `1019` (invalid token) after re-logging in from env credentials, patching the caller's `AuthData` in place. `getValidAuth()` returns the stored token without validating it — the retry is what recovers from an invalidated session.
- `/training/program/add` isn't documented and its response shape isn't captured, so `addWorkout()`/`addRunWorkout()` return the new id defensively: `extractWorkoutId()` accepts only a long digit string (the request payload carries `id: "0"`, so an echoed request must not be mistaken for an id), and falls back to `findWorkoutIdByName()` — query by name, keep the highest snowflake id. Creating a workout must always hand the caller an id, otherwise `schedule_workout` can't be chained after it.
- Base URLs: `teameuapi.coros.com` (EU), `teamapi.coros.com` (US). Region defaults to `eu`.
- `sportType: 4` = Strength Training, `sportType: 1` = Run.

## Running Workout Encoding

Derived from workouts created in the COROS web app and read back via `/training/program/query`; verified by round-trip in `src/__tests__/run-workout.test.ts`.

- `exerciseType`: 1=warm-up, 2=work, 3=cool-down, 4=recovery, 0=repeat group (`isGroup: true`, `sets` = repeat count, children carry its `id` as `groupId`).
- `sortNo`: `topIndex << 24`, with repeat children OR-ing in `childIndex << 16`. Both indices are 1-based.
- `targetType`: 5=distance (`targetValue` in **centimetres**), 2=duration (seconds). `targetDisplayUnit`: 1=km, 2=m, 0=time.
- `intensityType: 3` = pace range. `intensityValue`/`intensityValueExtend` are sec/km × 1000, **fastest first**.
- `intensityPercent`/`intensityPercentExtend` are percent-of-threshold-pace × 1000, paired **crossed** against the values (the slower pace carries the lower percent). Display-only — the watch follows `intensityValue`. Computed from `DEFAULT_THRESHOLD_PACE_SEC`.
- `/calculate` returns `planDuration`, `planDistance`, `planSets`, `planTrainingLoad` for running (not the flat shape the strength endpoint returns).
- Nested repeats are not supported by the API.
- `intensityPercent`/`intensityPercentExtend` are sent as `0`: the server derives them
  from the athlete's current threshold pace and overwrites whatever is sent. (Observed:
  values sent at create time came back different, matching `floor(threshold / pace * 100)`
  against the threshold pace shown on the Training Hub dashboard.)

## Scheduling Encoding

The whole schedule is **one plan document**, not per-day records. `GET
/training/schedule/query?startDate&endDate&supportRestExercise=1` (dates as `YYYYMMDD`)
returns it: `entities` are the dated slots, `programs` the workouts they point at,
joined by `idInPlan`.

Writing is `POST /training/schedule/update`:

```json
{
  "entities":       [{ "happenDay": "20260910", "idInPlan": N, "sortNoInSchedule": 1 }],
  "programs":       [ { ...GET /training/program/detail data..., "idInPlan": N } ],
  "versionObjects": [{ "id": N, "status": 1 }],
  "pbVersion": 2
}
```

- `N` = the plan's `maxIdInPlan` + 1. The same value links all three arrays.
- `sortNoInSchedule` orders multiple workouts within one day, from 1.
- The write is an upsert of the listed slots — other days are untouched.
- `scheduleWorkout()` reproduces this body byte-for-byte against a captured web-client
  request.
- Not captured yet: removing a scheduled workout.

## Exercise Catalog

`data/exercises.json` contains ~383 exercises bundled with the server. The `update_exercises` tool refreshes it from the COROS API + i18n CDN strings. Name resolution order: i18n → existing catalog fallback → raw code name (e.g. "T1004"). Only ~100 exercises have i18n coverage.

## Reference Material

The parent repo (`../`) contains research files useful for debugging API issues: captured curl commands (`create-workout-request-all.txt`), raw API responses (`strength-exercises.json`), and extracted i18n strings (`en-US.prod.js`).
