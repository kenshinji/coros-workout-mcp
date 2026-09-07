/**
 * Running workout support (sportType 1).
 *
 * Unlike strength workouts, running workouts have no exercise catalog: every
 * segment is one of four fixed COROS templates (warm-up / work / recovery /
 * cool-down) parameterised by a distance-or-duration target and a pace range.
 * Repeats are expressed as a group segment whose children carry its id.
 *
 * The numeric encodings below were derived from workouts created in the COROS
 * web app and read back via /training/program/query.
 */

import {
  RUN_SEGMENT_TEMPLATES,
  RUN_GROUP_NAME,
  RUN_SOURCE_ID,
  RUN_SOURCE_URL,
  DEFAULT_THRESHOLD_PACE_SEC,
  type RunStep,
  type RunSegmentKind,
  type RunExercisePayload,
  type RunWorkoutPayload,
} from "./types.js";

/** Parse "4:35" (min:sec per km) into seconds per km. */
export function parsePace(pace: string): number {
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(pace.trim());
  if (!match) {
    throw new Error(
      `Invalid pace "${pace}". Expected mm:ss per km, e.g. "4:35".`
    );
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Format seconds per km back into "4:35". */
export function formatPace(secPerKm: number): string {
  const total = Math.round(secPerKm);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Percent of threshold pace, as the API stores it (percent * 1000).
 * Faster pace -> higher percent, so this is the speed ratio, not the pace ratio.
 */
function intensityPercent(secPerKm: number, thresholdSec: number): number {
  return Math.round((thresholdSec / secPerKm) * 100) * 1000;
}

/**
 * Validate a pace range and return it fastest-first, matching the API's
 * intensityValue (fast) / intensityValueExtend (slow) pairing.
 */
function resolvePaceRange(step: {
  paceFrom?: string;
  paceTo?: string;
}): { fast: number; slow: number } {
  if (!step.paceFrom || !step.paceTo) {
    throw new Error("Both paceFrom and paceTo are required for a run segment.");
  }
  const a = parsePace(step.paceFrom);
  const b = parsePace(step.paceTo);
  return { fast: Math.min(a, b), slow: Math.max(a, b) };
}

/** sortNo encodes position: top-level index in bits 24+, child index in bits 16+. */
export function runSortNo(topIndex: number, childIndex = 0): number {
  return (topIndex << 24) | (childIndex << 16);
}

interface BuildContext {
  userId: number;
  thresholdSec: number;
  nextId: number;
}

function buildSegment(
  kind: RunSegmentKind,
  step: Extract<RunStep, { type: RunSegmentKind }>,
  sortNo: number,
  groupId: string,
  ctx: BuildContext
): RunExercisePayload {
  const tpl = RUN_SEGMENT_TEMPLATES[kind];
  const { fast, slow } = resolvePaceRange(step);

  const hasDistance = step.distanceM != null;
  const hasDuration = step.durationSec != null;
  if (hasDistance === hasDuration) {
    throw new Error(
      `Segment "${kind}" needs exactly one of distanceM or durationSec.`
    );
  }

  return {
    access: 0,
    animationId: 0,
    createTimestamp: 0,
    defaultOrder: 0,
    equipment: [1],
    exerciseKind: 0,
    exerciseType: tpl.exerciseType,
    gradeSystem: 0,
    groupId,
    hrType: 0,
    id: String(ctx.nextId++),
    intensityCustom: 0,
    intensityDisplayUnit: 1,
    intensityMultiplier: 1000,
    // The percent pair is stored crossed against the value pair: the slower
    // pace carries the lower percent.
    intensityPercent: intensityPercent(slow, ctx.thresholdSec),
    intensityPercentExtend: intensityPercent(fast, ctx.thresholdSec),
    intensityType: 3, // pace range
    intensityValue: fast * 1000,
    intensityValueExtend: slow * 1000,
    isDefaultAdd: 0,
    isGroup: false,
    isIntensityPercent: false,
    name: tpl.name,
    onsightGradeOffset: 0,
    originId: tpl.originId,
    overview: tpl.overview,
    packageTime: 0,
    part: [0],
    restType: 3,
    restValue: 0,
    sets: 1,
    sortNo,
    sourceId: "0",
    sourceUrl: "",
    sportType: 1,
    status: 1,
    subType: 0,
    // 1 = km, 2 = m, 0 = time
    targetDisplayUnit: hasDistance ? (step.distanceM! >= 1000 ? 1 : 2) : 0,
    targetType: hasDistance ? 5 : 2, // 5 = distance, 2 = duration
    targetValue: hasDistance ? step.distanceM! * 100 : step.durationSec!, // distance in cm
    userId: ctx.userId,
    videoInfos: [],
    videoUrl: "",
  };
}

function buildGroup(
  times: number,
  sortNo: number,
  ctx: BuildContext
): RunExercisePayload {
  return {
    access: 0,
    animationId: 0,
    createTimestamp: 0,
    defaultOrder: 0,
    exerciseKind: 0,
    exerciseType: 0,
    gradeSystem: 0,
    groupId: "0",
    hrType: 0,
    id: String(ctx.nextId++),
    intensityCustom: 0,
    intensityDisplayUnit: 0,
    intensityMultiplier: 0,
    intensityPercent: 0,
    intensityPercentExtend: 0,
    intensityType: 0,
    intensityValue: 0,
    intensityValueExtend: 0,
    isDefaultAdd: 0,
    isGroup: true,
    isIntensityPercent: false,
    name: RUN_GROUP_NAME,
    onsightGradeOffset: 0,
    originId: "0",
    overview: "",
    packageTime: 0,
    restType: 0,
    restValue: 0,
    sets: times,
    sortNo,
    sourceId: "0",
    sourceUrl: "",
    sportType: 1,
    status: 1,
    subType: 0,
    targetDisplayUnit: 1,
    targetType: 0,
    targetValue: 0,
    userId: ctx.userId,
    videoInfos: [],
    videoUrl: "",
  };
}

/** Flatten the step tree into the API's exercise array. */
export function buildRunExercises(
  steps: RunStep[],
  userId: string,
  thresholdPaceSec: number = DEFAULT_THRESHOLD_PACE_SEC
): RunExercisePayload[] {
  if (steps.length === 0) {
    throw new Error("A run workout needs at least one step.");
  }

  const ctx: BuildContext = {
    userId: Number(userId),
    thresholdSec: thresholdPaceSec,
    nextId: 1,
  };
  const out: RunExercisePayload[] = [];

  steps.forEach((step, i) => {
    const topIndex = i + 1;
    if (step.type === "repeat") {
      if (step.steps.length === 0) {
        throw new Error("A repeat step needs at least one child step.");
      }
      // Guard for callers outside the zod-validated tool boundary.
      if (step.steps.some((s) => (s.type as string) === "repeat")) {
        throw new Error("Nested repeat steps are not supported by the COROS API.");
      }
      const group = buildGroup(step.times, runSortNo(topIndex), ctx);
      out.push(group);
      step.steps.forEach((child, j) => {
        out.push(
          buildSegment(
            child.type as RunSegmentKind,
            child as Extract<RunStep, { type: RunSegmentKind }>,
            runSortNo(topIndex, j + 1),
            group.id,
            ctx
          )
        );
      });
    } else {
      out.push(
        buildSegment(
          step.type,
          step,
          runSortNo(topIndex),
          "0",
          ctx
        )
      );
    }
  });

  return out;
}

export function buildRunWorkoutPayload(
  name: string,
  overview: string,
  exercises: RunExercisePayload[]
): RunWorkoutPayload {
  return {
    access: 1,
    authorId: "0",
    createTimestamp: 0,
    distance: 0,
    distanceDisplayUnit: 1,
    duration: 0,
    elevGain: 0,
    essence: 0,
    estimatedType: 6,
    estimatedValue: 0,
    exerciseNum: 0,
    exercises,
    gradeSystemVersion: 0,
    headPic: "",
    hybridTotalSets: 0,
    id: "0",
    idInPlan: "0",
    isTargetTypeConsistent: 0,
    name,
    nickname: "",
    originEssence: 0,
    overview,
    pbVersion: 2,
    pitch: 0,
    planIdIndex: 0,
    poolLength: 0,
    poolLengthId: 0,
    poolLengthUnit: 0,
    referExercise: { gradeSystem: 0, hrType: 3, intensityType: 0, valueType: 1 },
    sex: 0,
    shareUrl: "",
    simple: false,
    sourceId: RUN_SOURCE_ID,
    sourceUrl: RUN_SOURCE_URL,
    sportType: 1,
    star: 0,
    status: 1,
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
  };
}

/** Human-readable one-line summary of a step, for tool output. */
export function describeStep(step: RunStep): string {
  if (step.type === "repeat") {
    return `${step.times}x [ ${step.steps.map(describeStep).join(" + ")} ]`;
  }
  const target =
    step.distanceM != null
      ? step.distanceM >= 1000
        ? `${step.distanceM / 1000}km`
        : `${step.distanceM}m`
      : `${Math.floor(step.durationSec! / 60)}:${String(step.durationSec! % 60).padStart(2, "0")}`;
  const { fast, slow } = resolvePaceRange(step);
  return `${step.type} ${target} @ ${formatPace(fast)}-${formatPace(slow)}/km`;
}
