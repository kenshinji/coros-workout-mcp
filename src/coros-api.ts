import { buildRunWorkoutPayload } from "./run-workout.js";
import { createHash } from "node:crypto";
import type {
  AuthData,
  CatalogExercise,
  ExerciseOverrides,
  ExercisePayload,
  RawExercise,
  Region,
  WorkoutPayload,
  RunExercisePayload,
  RunCalculateResult,
  SchedulePlan,
} from "./types.js";
import {
  REGION_URLS,
  MuscleCode,
  PartCode,
  EquipmentCode,
} from "./types.js";
import { findByName } from "./exercise-catalog.js";
import { getAuthStore } from "./auth-store.js";

const DEFAULT_SOURCE_URL =
  "https://d31oxp44ddzkyk.cloudfront.net/source/source_default/0/2fbd46e17bc54bc5873415c9fa767bdc.jpg";

// --- Auth ---

function md5(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

export async function storeAuth(auth: AuthData): Promise<void> {
  await getAuthStore().save(auth);
}

export async function loadAuth(): Promise<AuthData | null> {
  return getAuthStore().load();
}

/**
 * Every COROS endpoint answers with this envelope: "0000" means success.
 * Typed explicitly because `Response.json()` is `unknown` under the Workers
 * type definitions.
 */
interface ApiResponse {
  result: string;
  message?: string;
  data?: any;
}

export async function login(
  email: string,
  password: string,
  region: Region = "eu"
): Promise<AuthData> {
  const apiUrl = REGION_URLS[region];
  const res = await fetch(`${apiUrl}/account/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      account: email,
      accountType: 2,
      pwd: md5(password),
    }),
  });
  const data = (await res.json()) as ApiResponse;
  if (data.result !== "0000") {
    throw new Error(`COROS login failed: ${data.message || data.result}`);
  }

  const auth: AuthData = {
    accessToken: data.data.accessToken,
    userId: data.data.userId,
    region,
    timestamp: Date.now(),
  };
  await storeAuth(auth);
  return auth;
}

function envCredentials(): { email: string; password: string; region: Region } | null {
  const email = process.env.COROS_EMAIL;
  const password = process.env.COROS_PASSWORD;
  const region = (process.env.COROS_REGION as Region) || "eu";
  return email && password ? { email, password, region } : null;
}

/** Get auth from the auth store, falling back to env credentials. */
export async function getValidAuth(): Promise<AuthData | null> {
  const stored = await loadAuth();
  if (stored) return stored;

  const creds = envCredentials();
  return creds ? login(creds.email, creds.password, creds.region) : null;
}

/**
 * The stored token can be invalidated out from under us — notably by logging
 * into the COROS web app, which ends the API session. When that happens and we
 * have env credentials, log in again and patch the caller's auth object in
 * place so the retry and any later calls use the fresh token.
 */
async function refreshExpiredAuth(auth: AuthData): Promise<boolean> {
  const creds = envCredentials();
  if (!creds) return false;
  const fresh = await login(creds.email, creds.password, creds.region);
  auth.accessToken = fresh.accessToken;
  auth.userId = fresh.userId;
  auth.region = fresh.region;
  return true;
}

/** COROS result code for an invalid/expired access token. */
const TOKEN_INVALID = "1019";

// --- API helpers ---

function apiHeaders(auth: AuthData): Record<string, string> {
  return {
    "Content-Type": "application/json",
    accesstoken: auth.accessToken,
    yfheader: JSON.stringify({ userId: auth.userId }),
  };
}

async function apiPost(auth: AuthData, path: string, body: unknown): Promise<unknown> {
  const send = async () => {
    const res = await fetch(`${REGION_URLS[auth.region]}${path}`, {
      method: "POST",
      headers: apiHeaders(auth),
      body: JSON.stringify(body),
    });
    return res.json() as Promise<ApiResponse>;
  };

  let data = await send();
  if (data.result === TOKEN_INVALID && (await refreshExpiredAuth(auth))) {
    data = await send();
  }
  if (data.result !== "0000") {
    throw new Error(`COROS API error (${path}): ${data.message || data.result}`);
  }
  return data;
}

async function apiGet(
  auth: AuthData,
  path: string,
  params: Record<string, string | number> = {}
): Promise<unknown> {
  const send = async () => {
    const url = new URL(`${REGION_URLS[auth.region]}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: apiHeaders(auth),
    });
    return res.json() as Promise<ApiResponse>;
  };

  let data = await send();
  if (data.result === TOKEN_INVALID && (await refreshExpiredAuth(auth))) {
    data = await send();
  }
  if (data.result !== "0000") {
    throw new Error(`COROS API error (${path}): ${data.message || data.result}`);
  }
  return data;
}

/** Fetch the full exercise catalog from COROS API */
export async function queryExerciseCatalog(
  auth: AuthData,
  sportType: number = 4
): Promise<RawExercise[]> {
  const result = (await apiGet(auth, "/training/exercise/query", {
    userId: auth.userId,
    sportType,
  })) as { data: RawExercise[] };
  return result.data;
}

/** Fetch i18n strings from the COROS static CDN (no auth needed) */
export async function fetchI18nStrings(): Promise<Record<string, string>> {
  const url = "https://static.coros.com/locale/coros-traininghub-v2/en-US.prod.js";
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch i18n strings: ${res.status} ${res.statusText}`);
  }
  let text = await res.text();
  // Strip "window.en_US=" prefix and trailing semicolon
  text = text.replace(/^window\.en_US\s*=\s*/, "").replace(/;\s*$/, "");
  return JSON.parse(text);
}

/**
 * Transform raw exercises + i18n map into CatalogExercise[].
 * Name resolution order: i18n[codeName] → existingCatalog[codeName].name → codeName
 * The i18n file only covers ~100 of ~383 exercises, so the existing catalog
 * provides names for exercises that predate the i18n system.
 */
export function buildCatalogFromRaw(
  rawExercises: RawExercise[],
  i18n: Record<string, string>,
  existingCatalog: CatalogExercise[] = []
): { catalog: CatalogExercise[]; i18nMisses: string[] } {
  const i18nMisses: string[] = [];
  const catalog: CatalogExercise[] = [];

  // Build lookup from existing catalog by codeName for fallback
  const existingByCode = new Map<string, CatalogExercise>();
  for (const e of existingCatalog) {
    existingByCode.set(e.codeName, e);
  }

  for (const r of rawExercises) {
    // Resolve human-readable name:
    // 1. i18n (code name key, e.g. "T1300" → "Weighted Jump Squats")
    // 2. Existing catalog entry (for older exercises without i18n)
    // 3. Fall back to raw code name
    let humanName = i18n[r.name];
    if (!humanName) {
      const existing = existingByCode.get(r.name);
      if (existing) {
        humanName = existing.name;
      } else {
        humanName = r.name;
        i18nMisses.push(r.name);
      }
    }

    // Resolve description from i18n
    const desc = i18n[r.name + "_desc"] || "";

    // Build text fields from numeric codes
    const muscle = r.muscle || [];
    const muscleRelevance = r.muscleRelevance || [];
    const part = r.part || [];
    const equipment = r.equipment || [];
    const primaryMuscle = muscle[0];
    const secondaryMuscles = muscleRelevance.filter((m) => m !== primaryMuscle);
    const muscleText = primaryMuscle
      ? (MuscleCode as Record<number, string>)[primaryMuscle] || String(primaryMuscle)
      : "";
    const secondaryMuscleText = secondaryMuscles
      .map((m) => (MuscleCode as Record<number, string>)[m] || String(m))
      .join(",");
    const partText = part
      .map((p) => (PartCode as Record<number, string>)[p] || String(p))
      .join(",");
    const equipmentText = equipment
      .map((e) => (EquipmentCode as Record<number, string>)[e] || String(e))
      .join(",");

    catalog.push({
      id: r.id,
      name: humanName.trim(),
      codeName: r.name,
      overview: r.overview,
      animationId: r.animationId,
      muscle,
      muscleRelevance,
      part,
      equipment,
      exerciseType: r.exerciseType,
      targetType: r.targetType,
      targetValue: r.targetValue,
      intensityType: r.intensityType,
      intensityValue: r.intensityValue,
      restType: r.restType,
      restValue: r.restValue,
      sets: r.sets,
      sortNo: r.sortNo,
      sportType: r.sportType,
      status: r.status,
      createTimestamp: r.createTimestamp,
      thumbnailUrl: r.thumbnailUrl || "",
      sourceUrl: r.sourceUrl,
      videoUrl: r.videoUrl,
      coverUrlArrStr: r.coverUrlArrStr,
      videoUrlArrStr: r.videoUrlArrStr,
      videoInfos: r.videoInfos,
      muscleText,
      secondaryMuscleText,
      partText,
      equipmentText,
      desc,
    });
  }

  // Sort alphabetically by name
  catalog.sort((a, b) => a.name.localeCompare(b.name));

  return { catalog, i18nMisses };
}

// --- Payload construction ---

export function buildExercisePayload(
  exercise: CatalogExercise,
  sortNo: number,
  overrides: Partial<ExerciseOverrides> = {}
): ExercisePayload {
  const sets = overrides.sets ?? exercise.sets;
  let targetType = exercise.targetType;
  let targetValue = exercise.targetValue;
  if (overrides.reps !== undefined) {
    targetType = 3;
    targetValue = overrides.reps;
  } else if (overrides.duration !== undefined) {
    targetType = 2;
    targetValue = overrides.duration;
  }

  const restValue = overrides.restSeconds ?? exercise.restValue;

  let intensityType = exercise.intensityType;
  let intensityValue = exercise.intensityValue;
  if (overrides.weightGrams !== undefined) {
    intensityType = 1;
    intensityValue = overrides.weightGrams;
  } else if (overrides.weightKg !== undefined) {
    intensityType = 1;
    intensityValue = overrides.weightKg * 1000;
  }

  // Build text fields from codes
  const primaryMuscle = exercise.muscle[0];
  const secondaryMuscles = (exercise.muscleRelevance || []).filter(
    (m) => m !== primaryMuscle
  );
  const muscleText =
    exercise.muscleText ||
    (primaryMuscle
      ? (MuscleCode as Record<number, string>)[primaryMuscle] || ""
      : "");
  const secondaryMuscleText =
    exercise.secondaryMuscleText ||
    secondaryMuscles
      .map((m) => (MuscleCode as Record<number, string>)[m] || "")
      .filter(Boolean)
      .join(",");
  const partText =
    exercise.partText ||
    exercise.part
      .map((p) => (PartCode as Record<number, string>)[p] || "")
      .filter(Boolean)
      .join(",");
  const equipmentText =
    exercise.equipmentText ||
    exercise.equipment
      .map((e) => (EquipmentCode as Record<number, string>)[e] || "")
      .filter(Boolean)
      .join(",");

  return {
    access: 0,
    animationId: exercise.animationId ?? 0,
    coverUrlArrStr: exercise.coverUrlArrStr,
    createTimestamp: exercise.createTimestamp,
    defaultOrder: 0,
    equipment: exercise.equipment,
    exerciseType: exercise.exerciseType,
    id: sortNo, // sequential 1-based index used in API
    intensityCustom: 0,
    intensityType,
    intensityValue,
    isDefaultAdd: 0,
    isGroup: false,
    isIntensityPercent: false,
    muscle: exercise.muscle,
    muscleRelevance: exercise.muscleRelevance || [],
    name: exercise.codeName,
    overview: exercise.overview,
    part: exercise.part,
    restType: 1,
    restValue,
    sets,
    sortNo,
    sourceUrl: exercise.sourceUrl,
    sportType: 4,
    status: 1,
    targetType,
    targetValue,
    thumbnailUrl: exercise.thumbnailUrl,
    userId: 0,
    videoInfos: exercise.videoInfos,
    videoUrl: exercise.videoUrl,
    videoUrlArrStr: exercise.videoUrlArrStr,
    nameText: exercise.name,
    desc: exercise.desc,
    descText: exercise.desc,
    partText,
    muscleText,
    secondaryMuscleText,
    equipmentText,
    groupId: "",
    originId: exercise.id,
    targetDisplayUnit: 0,
    hrType: 0,
    intensityValueExtend: 0,
    intensityMultiplier: 0,
    intensityPercent: 0,
    intensityPercentExtend: 0,
    intensityDisplayUnit: "6",
  };
}

export function buildWorkoutPayload(
  name: string,
  overview: string,
  exercisePayloads: ExercisePayload[]
): WorkoutPayload {
  return {
    access: 1,
    authorId: "0",
    createTimestamp: 0,
    distance: 0,
    duration: 0,
    essence: 0,
    estimatedType: 0,
    estimatedValue: 0,
    exerciseNum: 0,
    exercises: exercisePayloads,
    headPic: "",
    id: "0",
    idInPlan: "0",
    name,
    nickname: "",
    originEssence: 0,
    overview,
    pbVersion: 2,
    planIdIndex: 0,
    poolLength: 2500,
    profile: "",
    referExercise: { intensityType: 1, hrType: 0, valueType: 1 },
    sex: 0,
    shareUrl: "",
    simple: false,
    sourceUrl: DEFAULT_SOURCE_URL,
    sportType: 4,
    star: 0,
    subType: 65535,
    targetType: 0,
    targetValue: 0,
    thirdPartyId: 0,
    totalSets: 0,
    trainingLoad: 0,
    type: 0,
    unit: 0,
    userId: "0",
    version: 0,
    videoCoverUrl: "",
    videoUrl: "",
    fastIntensityTypeName: "weight",
    poolLengthId: 1,
    poolLengthUnit: 2,
    sourceId: "425868133463670784",
  };
}

/** Resolve exercise overrides to catalog entries and build payloads */
export function resolveExercises(
  exercises: ExerciseOverrides[]
): ExercisePayload[] {
  return exercises.map((override, index) => {
    const catalog = findByName(override.name);
    if (!catalog) {
      throw new Error(`Exercise not found in catalog: "${override.name}"`);
    }
    return buildExercisePayload(catalog, index + 1, override);
  });
}

// --- Workout API ---

export interface CalculateResult {
  duration: number;
  totalSets: number;
  trainingLoad: number;
}

export async function calculateWorkout(
  auth: AuthData,
  name: string,
  overview: string,
  exercisePayloads: ExercisePayload[]
): Promise<CalculateResult> {
  const payload = buildWorkoutPayload(name, overview, exercisePayloads);
  const result = (await apiPost(auth, "/training/program/calculate", payload)) as {
    data: { duration: number; totalSets: number; trainingLoad: number };
  };
  return {
    duration: result.data.duration,
    totalSets: result.data.totalSets,
    trainingLoad: result.data.trainingLoad,
  };
}

/** One row of `/training/program/query`. */
export interface WorkoutSummary {
  id: string;
  name: string;
  overview?: string;
  sportType: number;
  duration?: number;
  estimatedTime?: number;
  estimatedDistance?: number;
  totalSets?: number;
  exerciseNum?: number;
}

/**
 * Dig the new workout's id out of an `/add` response. The endpoint isn't
 * documented and has been seen answering with the id in more than one shape,
 * so try each and let the caller fall back to a lookup by name.
 */
function extractWorkoutId(response: ApiResponse): string | null {
  const data = response?.data;
  const candidate =
    typeof data === "string" || typeof data === "number"
      ? data
      : data?.id ?? data?.programId ?? data?.programIdStr;
  const id = candidate === undefined || candidate === null ? "" : String(candidate);
  // Real ids are long snowflakes. The request payload carries `id: "0"`, so an
  // echoed request would otherwise look like a successful extraction.
  return /^\d{6,}$/.test(id) ? id : null;
}

/** Highest id wins: COROS ids are snowflakes, so the newest sorts last. */
function newestId(workouts: WorkoutSummary[]): string | null {
  let best: string | null = null;
  for (const w of workouts) {
    if (!w?.id) continue;
    try {
      if (best === null || BigInt(w.id) > BigInt(best)) best = w.id;
    } catch {
      best ??= w.id;
    }
  }
  return best;
}

/**
 * Fallback for when `/add` doesn't hand back an id: ask for workouts with this
 * name and take the newest, which is the one just created.
 */
export async function findWorkoutIdByName(
  auth: AuthData,
  name: string,
  sportType = 0
): Promise<string | null> {
  const result = (await queryWorkouts(auth, {
    name,
    sportType,
    limitSize: 20,
  })) as { data?: WorkoutSummary[] };
  const candidates = result.data ?? [];
  const exact = candidates.filter((w) => w.name === name);
  return newestId(exact.length > 0 ? exact : candidates);
}

export async function addWorkout(
  auth: AuthData,
  name: string,
  overview: string,
  exercisePayloads: ExercisePayload[],
  calculated: CalculateResult
): Promise<string | null> {
  const payload = buildWorkoutPayload(name, overview, exercisePayloads);
  // Apply calculated values
  payload.duration = calculated.duration;
  payload.totalSets = calculated.totalSets;
  payload.distance = "0"; // String in add (number in calculate)
  payload.sets = calculated.totalSets;
  payload.pitch = 0;
  const response = (await apiPost(auth, "/training/program/add", payload)) as ApiResponse;
  return extractWorkoutId(response) ?? findWorkoutIdByName(auth, name, 4);
}

export interface QueryOptions {
  name?: string;
  sportType?: number;
  startNo?: number;
  limitSize?: number;
}

export async function queryWorkouts(
  auth: AuthData,
  options: QueryOptions = {}
): Promise<unknown> {
  const body = {
    name: options.name || "",
    supportRestExercise: 1,
    startNo: options.startNo ?? 0,
    limitSize: options.limitSize ?? 10,
    sportType: options.sportType ?? 0,
  };
  return apiPost(auth, "/training/program/query", body);
}

// --- Running workout API (sportType 1) ---

/**
 * Calculate metrics for a running workout. The server expands repeat groups
 * and returns plan* fields (rather than the strength endpoint's flat shape).
 */
export async function calculateRunWorkout(
  auth: AuthData,
  name: string,
  overview: string,
  exercises: RunExercisePayload[]
): Promise<RunCalculateResult> {
  const payload = buildRunWorkoutPayload(name, overview, exercises);
  const result = (await apiPost(auth, "/training/program/calculate", payload)) as {
    data: {
      planDuration: number;
      planDistance: string;
      planSets: number;
      planTrainingLoad: number;
    };
  };
  return {
    duration: result.data.planDuration,
    distanceCm: Math.round(Number(result.data.planDistance)),
    totalSets: result.data.planSets,
    trainingLoad: result.data.planTrainingLoad,
  };
}

export async function addRunWorkout(
  auth: AuthData,
  name: string,
  overview: string,
  exercises: RunExercisePayload[],
  calculated: RunCalculateResult
): Promise<string | null> {
  const payload = buildRunWorkoutPayload(name, overview, exercises);
  payload.duration = calculated.duration;
  payload.totalSets = calculated.totalSets;
  payload.sets = calculated.totalSets;
  payload.trainingLoad = calculated.trainingLoad;
  payload.estimatedValue = calculated.trainingLoad;
  payload.distance = "0";
  const response = (await apiPost(auth, "/training/program/add", payload)) as ApiResponse;
  return extractWorkoutId(response) ?? findWorkoutIdByName(auth, name, 1);
}

// --- Schedule API ---

/** "2026-09-08" or "20260908" -> "20260908" */
export function toApiDate(date: string): string {
  const compact = date.replace(/-/g, "");
  if (!/^\d{8}$/.test(compact)) {
    throw new Error(`Invalid date "${date}". Expected YYYY-MM-DD or YYYYMMDD.`);
  }
  return compact;
}

/**
 * The schedule is a single plan document: `entities` are the scheduled slots
 * and `programs` the workouts they point at, joined by `idInPlan`.
 */
export async function querySchedule(
  auth: AuthData,
  startDate: string,
  endDate: string
): Promise<SchedulePlan> {
  const result = (await apiGet(auth, "/training/schedule/query", {
    startDate: toApiDate(startDate),
    endDate: toApiDate(endDate),
    supportRestExercise: 1,
  })) as { data: SchedulePlan };
  return result.data;
}

/** Fetch a saved workout in the shape /training/schedule/update expects. */
export async function getWorkoutDetail(
  auth: AuthData,
  workoutId: string
): Promise<Record<string, unknown>> {
  const result = (await apiGet(auth, "/training/program/detail", {
    id: workoutId,
    supportRestExercise: 1,
  })) as { data: Record<string, unknown> };
  return result.data;
}

/**
 * Put an existing workout on a date. Upserts a single slot — other days in the
 * plan are left alone.
 *
 * `idInPlan` is a plan-wide counter: the next slot takes maxIdInPlan + 1, and
 * the same value links the entity, the program copy and the version object.
 */
export async function scheduleWorkout(
  auth: AuthData,
  workoutId: string,
  date: string,
  sortNoInSchedule: number = 1
): Promise<{ happenDay: string; idInPlan: number; name: string }> {
  const happenDay = toApiDate(date);

  const [plan, program] = await Promise.all([
    querySchedule(auth, happenDay, happenDay),
    getWorkoutDetail(auth, workoutId),
  ]);

  const idInPlan = Number(plan.maxIdInPlan ?? 0) + 1;

  // The web client zeroes these out; the server recomputes them from the
  // athlete's current threshold pace. Sending our own values is pointless.
  const exercises = (program.exercises as Record<string, unknown>[] | undefined)?.map(
    (e) => ({ ...e, intensityPercent: 0, intensityPercentExtend: 0 })
  );

  const body = {
    entities: [{ happenDay, idInPlan, sortNoInSchedule }],
    programs: [{ ...program, ...(exercises ? { exercises } : {}), idInPlan }],
    versionObjects: [{ id: idInPlan, status: 1 }],
    pbVersion: program.pbVersion ?? 2,
  };

  await apiPost(auth, "/training/schedule/update", body);

  return { happenDay, idInPlan, name: String(program.name ?? workoutId) };
}
