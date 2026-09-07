#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { writeFileSync } from "node:fs";
import {
  login,
  loadDotEnv,
  getValidAuth,
  loadAuth,
  resolveExercises,
  calculateWorkout,
  addWorkout,
  queryWorkouts,
  queryExerciseCatalog,
  fetchI18nStrings,
  buildCatalogFromRaw,
  calculateRunWorkout,
  addRunWorkout,
  scheduleWorkout,
  querySchedule,
  toApiDate,
} from "./coros-api.js";
import { buildRunExercises, describeStep } from "./run-workout.js";
import {
  searchExercises,
  findByName,
  getAllExercises,
  reloadCatalog,
  getCatalogPath,
} from "./exercise-catalog.js";
import type { Region, RunStep } from "./types.js";

// Pick up COROS_EMAIL / COROS_PASSWORD / COROS_REGION from a .env file at the
// project root. Must run before any tool reads process.env.
loadDotEnv();

const server = new McpServer({
  name: "coros-workout",
  version: "1.0.0",
});

// --- Tool: authenticate_coros ---
server.tool(
  "authenticate_coros",
  "Log in to COROS Training Hub. Stores auth token for subsequent calls. Also checks COROS_EMAIL/COROS_PASSWORD env vars for auto-login. WARNING: Logging in via API invalidates the web app session.",
  {
    email: z.string().email().optional().describe("COROS account email (optional if env vars set)"),
    password: z.string().optional().describe("COROS account password (optional if env vars set)"),
    region: z.enum(["us", "eu"]).default("eu").describe("API region: 'us' or 'eu'"),
  },
  async ({ email, password, region }) => {
    try {
      // Use provided credentials or fall back to env vars
      const loginEmail = email || process.env.COROS_EMAIL;
      const loginPassword = password || process.env.COROS_PASSWORD;
      const loginRegion = (region || process.env.COROS_REGION || "eu") as Region;

      if (!loginEmail || !loginPassword) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No credentials provided. Set COROS_EMAIL and COROS_PASSWORD environment variables, or provide email and password parameters.",
            },
          ],
        };
      }

      const auth = await login(loginEmail, loginPassword, loginRegion);
      return {
        content: [
          {
            type: "text" as const,
            text: `Authenticated successfully. User ID: ${auth.userId}, Region: ${auth.region}. Token stored at ~/.config/coros-workout-mcp/auth.json`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Authentication failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// --- Tool: check_coros_auth ---
server.tool(
  "check_coros_auth",
  "Check if COROS authentication is available (from stored token or env vars).",
  {},
  async () => {
    const auth = await getValidAuth();
    if (auth) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Authenticated. User ID: ${auth.userId}, Region: ${auth.region}`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: "Not authenticated. Use authenticate_coros tool or set COROS_EMAIL/COROS_PASSWORD env vars.",
        },
      ],
    };
  }
);

// --- Tool: search_exercises ---
server.tool(
  "search_exercises",
  "Search the COROS exercise catalog (~383 strength exercises). Filter by name, muscle group, body part, and/or equipment. Returns exercise names, muscles, equipment, and default sets/reps.",
  {
    query: z.string().optional().describe("Search by exercise name (partial match, e.g. 'bench press')"),
    muscle: z.string().optional().describe("Filter by muscle group (e.g. 'chest', 'biceps', 'glutes', 'quadriceps')"),
    bodyPart: z.string().optional().describe("Filter by body part (e.g. 'legs', 'arms', 'core', 'chest', 'back', 'shoulders')"),
    equipment: z.string().optional().describe("Filter by equipment (e.g. 'bodyweight', 'dumbbells', 'barbells', 'kettlebell', 'bands')"),
    limit: z.number().int().min(1).max(50).default(20).describe("Max results to return"),
  },
  async ({ query, muscle, bodyPart, equipment, limit }) => {
    const results = searchExercises({ query, muscle, bodyPart, equipment });
    const limited = results.slice(0, limit);

    if (limited.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No exercises found matching your search criteria.",
          },
        ],
      };
    }

    const formatted = limited.map((e) => {
      const lines = [
        `**${e.name}**`,
        `  Muscles: ${e.muscleText}${e.secondaryMuscleText ? ` (secondary: ${e.secondaryMuscleText})` : ""}`,
        `  Body parts: ${e.partText}`,
        `  Equipment: ${e.equipmentText}`,
        `  Defaults: ${e.sets} sets x ${e.targetValue} ${e.targetType === 3 ? "reps" : "seconds"}, ${e.restValue}s rest`,
      ];
      return lines.join("\n");
    });

    const header = `Found ${results.length} exercises${results.length > limit ? ` (showing first ${limit})` : ""}:\n`;
    return {
      content: [
        {
          type: "text" as const,
          text: header + formatted.join("\n\n"),
        },
      ],
    };
  }
);

// --- Tool: create_workout ---
const ExerciseInputSchema = z.object({
  name: z.string().describe("Exercise name (must match catalog exactly, e.g. 'Push-ups', 'Squats')"),
  sets: z.number().int().min(1).optional().describe("Number of sets (defaults to catalog value)"),
  reps: z.number().int().min(1).optional().describe("Reps per set (defaults to catalog value)"),
  duration: z.number().int().min(1).optional().describe("Duration in seconds per set (alternative to reps)"),
  restSeconds: z.number().int().min(0).optional().describe("Rest between sets in seconds (defaults to catalog value)"),
  weightKg: z.number().min(0).optional().describe("Weight in kg (e.g. 20 for 20kg)"),
});

server.tool(
  "create_workout",
  "Create a strength workout on COROS Training Hub. Resolves exercise names from the catalog, builds the full API payload, calculates metrics, and saves the workout. The workout will sync to the user's COROS watch.",
  {
    name: z.string().describe("Workout name (e.g. 'Upper Body Push')"),
    overview: z.string().default("").describe("Workout description"),
    exercises: z.array(ExerciseInputSchema).min(1).describe("Array of exercises with optional overrides"),
  },
  async ({ name, overview, exercises }) => {
    try {
      const auth = await getValidAuth();
      if (!auth) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Not authenticated. Use authenticate_coros first.",
            },
          ],
          isError: true,
        };
      }

      // Validate all exercise names first
      const missing: string[] = [];
      for (const ex of exercises) {
        if (!findByName(ex.name)) {
          missing.push(ex.name);
        }
      }
      if (missing.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Exercises not found in catalog: ${missing.map((n) => `"${n}"`).join(", ")}. Use search_exercises to find the correct names.`,
            },
          ],
          isError: true,
        };
      }

      // Build payloads
      const exercisePayloads = resolveExercises(exercises);

      // Calculate metrics
      const calculated = await calculateWorkout(
        auth,
        name,
        overview,
        exercisePayloads
      );

      // Create the workout
      await addWorkout(auth, name, overview, exercisePayloads, calculated);

      const totalSets = exercises.reduce(
        (sum, ex) => sum + (ex.sets ?? findByName(ex.name)!.sets),
        0
      );
      const exerciseSummary = exercises
        .map((ex) => {
          const catalog = findByName(ex.name)!;
          const sets = ex.sets ?? catalog.sets;
          const target = ex.reps ?? ex.duration ?? catalog.targetValue;
          const unit = (ex.reps || (!ex.duration && catalog.targetType === 3)) ? "reps" : "s";
          const weight = ex.weightKg ? ` @ ${ex.weightKg}kg` : "";
          return `  ${ex.name}: ${sets}x${target}${unit}${weight}`;
        })
        .join("\n");

      const durationMin = Math.round(calculated.duration / 60);

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Workout "${name}" created successfully!`,
              `Duration: ~${durationMin} min | Sets: ${calculated.totalSets} | Training load: ${calculated.trainingLoad}`,
              ``,
              `Exercises:`,
              exerciseSummary,
              ``,
              `The workout will sync to your COROS watch.`,
            ].join("\n"),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to create workout: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// --- Tool: update_exercises ---
server.tool(
  "update_exercises",
  "Fetch the latest exercise catalog from COROS APIs and rebuild the local catalog. Requires authentication. Fetches exercises from the COROS API and i18n strings for human-readable names.",
  {
    sportType: z
      .number()
      .int()
      .default(4)
      .describe("Sport type to fetch exercises for (default 4 = strength)"),
  },
  async ({ sportType }) => {
    try {
      const auth = await getValidAuth();
      if (!auth) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Not authenticated. Use authenticate_coros first.",
            },
          ],
          isError: true,
        };
      }

      // Get current catalog for comparison and as fallback for names
      let oldExercises: ReturnType<typeof getAllExercises> = [];
      let oldNames: Set<string>;
      try {
        oldExercises = getAllExercises();
        oldNames = new Set(oldExercises.map((e) => e.name));
      } catch {
        oldNames = new Set();
      }

      // Fetch exercises and i18n in parallel
      const [rawExercises, i18n] = await Promise.all([
        queryExerciseCatalog(auth, sportType),
        fetchI18nStrings(),
      ]);

      // Build catalog (pass existing catalog for name fallback)
      const { catalog, i18nMisses } = buildCatalogFromRaw(
        rawExercises,
        i18n,
        oldExercises
      );

      // Compare with old catalog
      const newNames = new Set(catalog.map((e) => e.name));
      const added = [...newNames].filter((n) => !oldNames.has(n));
      const removed = [...oldNames].filter((n) => !newNames.has(n));

      // Write to disk
      const catalogPath = getCatalogPath();
      writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));

      // Reload in-memory cache
      reloadCatalog();

      // Build summary
      const lines = [
        `Exercise catalog updated successfully.`,
        `Total exercises: ${catalog.length}`,
      ];
      if (added.length > 0) {
        lines.push(`New exercises (${added.length}): ${added.join(", ")}`);
      }
      if (removed.length > 0) {
        lines.push(
          `Removed exercises (${removed.length}): ${removed.join(", ")}`
        );
      }
      if (added.length === 0 && removed.length === 0) {
        lines.push("No changes in exercise list.");
      }
      if (i18nMisses.length > 0) {
        lines.push(
          `i18n misses (${i18nMisses.length}): ${i18nMisses.slice(0, 10).join(", ")}${i18nMisses.length > 10 ? "..." : ""}`
        );
      }
      lines.push(`Catalog written to: ${catalogPath}`);

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to update exercises: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// --- Tool: create_run_workout ---

const RunSegmentSchema = z.object({
  type: z
    .enum(["warmup", "work", "recovery", "cooldown"])
    .describe("Segment role: warmup, work (the hard part), recovery (between reps), cooldown"),
  distanceM: z
    .number()
    .min(1)
    .optional()
    .describe("Distance target in metres (e.g. 800). Use this OR durationSec, not both."),
  durationSec: z
    .number()
    .min(1)
    .optional()
    .describe("Duration target in seconds (e.g. 150). Use this OR distanceM, not both."),
  paceFrom: z.string().describe('Fast end of the pace range, mm:ss per km (e.g. "4:35")'),
  paceTo: z.string().describe('Slow end of the pace range, mm:ss per km (e.g. "4:50")'),
});

const RunStepSchema = z.union([
  RunSegmentSchema,
  z.object({
    type: z.literal("repeat"),
    times: z.number().min(1).max(50).describe("How many times to repeat the child steps"),
    steps: z.array(RunSegmentSchema).min(1).describe("Steps inside the repeat (e.g. work + recovery)"),
  }),
]);

server.tool(
  "create_run_workout",
  "Create a structured running workout (intervals, tempo, fartlek, easy run) on COROS Training Hub. Steps are warmup/work/recovery/cooldown segments, each with a distance or duration target and a pace range; wrap steps in a 'repeat' step for intervals. The workout syncs to the user's COROS watch.",
  {
    name: z.string().describe("Workout name (e.g. 'Intervals 5x800m')"),
    overview: z.string().default("").describe("Workout description"),
    steps: z.array(RunStepSchema).min(1).describe("Ordered list of workout steps"),
  },
  async ({ name, overview, steps }) => {
    try {
      const auth = await getValidAuth();
      if (!auth) {
        return {
          content: [
            { type: "text" as const, text: "Not authenticated. Use authenticate_coros first." },
          ],
          isError: true,
        };
      }

      const exercises = buildRunExercises(steps as RunStep[], auth.userId);
      const calculated = await calculateRunWorkout(auth, name, overview, exercises);
      await addRunWorkout(auth, name, overview, exercises, calculated);

      const km = (calculated.distanceCm / 100000).toFixed(2);
      const mins = Math.floor(calculated.duration / 60);
      const secs = calculated.duration % 60;

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Run workout "${name}" created successfully!`,
              `Distance: ~${km} km | Duration: ~${mins}:${String(secs).padStart(2, "0")} | Segments: ${calculated.totalSets} | Training load: ${calculated.trainingLoad}`,
              ``,
              `Structure:`,
              ...(steps as RunStep[]).map((s) => `  ${describeStep(s)}`),
              ``,
              `The workout will sync to your COROS watch.`,
            ].join("\n"),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to create run workout: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// --- Tool: schedule_workout ---
server.tool(
  "schedule_workout",
  "Put an existing COROS workout on a calendar date, so it appears on that day in Training Hub and on the watch. Use list_workouts to find the workout id. Scheduling one day does not affect other days.",
  {
    workoutId: z.string().describe("Workout id from list_workouts (e.g. '1234567890123456789')"),
    date: z.string().describe("Date to schedule it on, YYYY-MM-DD (e.g. '2026-09-08')"),
    sortNoInSchedule: z
      .number()
      .min(1)
      .default(1)
      .describe("Order within that day when scheduling more than one workout"),
  },
  async ({ workoutId, date, sortNoInSchedule }) => {
    try {
      const auth = await getValidAuth();
      if (!auth) {
        return {
          content: [{ type: "text" as const, text: "Not authenticated. Use authenticate_coros first." }],
          isError: true,
        };
      }
      const res = await scheduleWorkout(auth, workoutId, date, sortNoInSchedule);
      const d = res.happenDay;
      return {
        content: [
          {
            type: "text" as const,
            text: `Scheduled "${res.name}" on ${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}. It will sync to your COROS watch.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to schedule workout: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// --- Tool: list_scheduled_workouts ---
server.tool(
  "list_scheduled_workouts",
  "List workouts scheduled on the COROS calendar between two dates.",
  {
    startDate: z.string().describe("Start of the range, YYYY-MM-DD"),
    endDate: z.string().describe("End of the range, YYYY-MM-DD"),
  },
  async ({ startDate, endDate }) => {
    try {
      const auth = await getValidAuth();
      if (!auth) {
        return {
          content: [{ type: "text" as const, text: "Not authenticated. Use authenticate_coros first." }],
          isError: true,
        };
      }
      const plan = await querySchedule(auth, startDate, endDate);
      const byId = new Map(
        (plan.programs ?? []).map((p) => [String(p.idInPlan), p])
      );
      const from = Number(toApiDate(startDate));
      const to = Number(toApiDate(endDate));
      const rows = (plan.entities ?? [])
        .filter((e) => Number(e.happenDay) >= from && Number(e.happenDay) <= to)
        .sort((a, b) => Number(a.happenDay) - Number(b.happenDay))
        .map((e) => {
          const p = byId.get(String(e.idInPlan));
          const d = String(e.happenDay);
          const when = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
          if (!p) return `  ${when}: (workout ${e.idInPlan} not in response)`;
          const km = p.estimatedDistance ? ` | ${(p.estimatedDistance / 100000).toFixed(2)} km` : "";
          const mins = p.estimatedTime ? ` | ~${Math.round(p.estimatedTime / 60)} min` : "";
          return `  ${when}: ${p.name} (id ${p.id})${km}${mins}`;
        });

      return {
        content: [
          {
            type: "text" as const,
            text: rows.length
              ? `Scheduled workouts ${startDate} to ${endDate}:\n${rows.join("\n")}`
              : `No workouts scheduled between ${startDate} and ${endDate}.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to list scheduled workouts: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// --- Tool: list_workouts ---
server.tool(
  "list_workouts",
  "List workouts from COROS Training Hub.",
  {
    name: z.string().default("").describe("Filter by workout name (optional)"),
    sportType: z.number().int().default(0).describe("Filter by sport type (0=all, 4=strength)"),
    limit: z.number().int().min(1).max(50).default(10).describe("Number of workouts to return"),
  },
  async ({ name, sportType, limit }) => {
    try {
      const auth = await getValidAuth();
      if (!auth) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Not authenticated. Use authenticate_coros first.",
            },
          ],
          isError: true,
        };
      }

      const result = (await queryWorkouts(auth, {
        name,
        sportType,
        limitSize: limit,
      })) as { data: Array<{ name: string; overview: string; sportType: number; duration: number; totalSets: number; exerciseNum: number; estimatedTime: number }> };

      const workouts = result.data || [];
      if (workouts.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No workouts found.",
            },
          ],
        };
      }

      const formatted = workouts
        .map((w) => {
          const durationMin = Math.round((w.estimatedTime || w.duration || 0) / 60);
          return `- **${w.name}** (${durationMin} min, ${w.totalSets || 0} sets, ${w.exerciseNum || 0} exercises)${w.overview ? `\n  ${w.overview}` : ""}`;
        })
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${workouts.length} workout(s):\n\n${formatted}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to list workouts: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// --- Start server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});
