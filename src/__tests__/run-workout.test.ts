import { describe, it, expect } from "vitest";
import {
  parsePace,
  formatPace,
  runSortNo,
  buildRunExercises,
  buildRunWorkoutPayload,
  describeStep,
} from "../run-workout.js";
import type { RunStep } from "../types.js";

const USER_ID = "469084832664666112";

/**
 * Mirrors the "5x800间歇跑" workout read back from the COROS API, which is the
 * reference the encoding was derived from.
 */
const REFERENCE_STEPS: RunStep[] = [
  { type: "warmup", distanceM: 2000, paceFrom: "6:30", paceTo: "7:00" },
  {
    type: "repeat",
    times: 5,
    steps: [
      { type: "work", distanceM: 800, paceFrom: "4:40", paceTo: "4:55" },
      { type: "recovery", durationSec: 170, paceFrom: "7:00", paceTo: "7:30" },
    ],
  },
  { type: "cooldown", distanceM: 2000, paceFrom: "6:30", paceTo: "7:30" },
];

describe("parsePace / formatPace", () => {
  it("parses mm:ss into seconds per km", () => {
    expect(parsePace("4:35")).toBe(275);
    expect(parsePace("7:00")).toBe(420);
    expect(parsePace("10:05")).toBe(605);
  });

  it("round-trips", () => {
    expect(formatPace(parsePace("4:35"))).toBe("4:35");
    expect(formatPace(parsePace("6:05"))).toBe("6:05");
  });

  it("rejects malformed paces", () => {
    expect(() => parsePace("4:60")).toThrow(/Invalid pace/);
    expect(() => parsePace("435")).toThrow(/Invalid pace/);
    expect(() => parsePace("")).toThrow(/Invalid pace/);
  });
});

describe("runSortNo", () => {
  it("matches the values observed in the API", () => {
    expect(runSortNo(1)).toBe(16777216);
    expect(runSortNo(2)).toBe(33554432);
    expect(runSortNo(3)).toBe(50331648);
    expect(runSortNo(2, 1)).toBe(33619968);
    expect(runSortNo(2, 2)).toBe(33685504);
  });
});

describe("buildRunExercises", () => {
  const ex = buildRunExercises(REFERENCE_STEPS, USER_ID);

  it("flattens the tree into warmup, group, children, cooldown", () => {
    expect(ex.map((e) => e.exerciseType)).toEqual([1, 0, 2, 4, 3]);
    expect(ex.map((e) => e.name)).toEqual([
      "T1120",
      "训练",
      "T3001",
      "T1123",
      "T1122",
    ]);
  });

  it("positions segments with the observed sortNo encoding", () => {
    expect(ex.map((e) => e.sortNo)).toEqual([
      16777216, 33554432, 33619968, 33685504, 50331648,
    ]);
  });

  it("links repeat children to their group and leaves others top-level", () => {
    const group = ex[1];
    expect(group.isGroup).toBe(true);
    expect(group.sets).toBe(5);
    expect(ex[2].groupId).toBe(group.id);
    expect(ex[3].groupId).toBe(group.id);
    expect(ex[0].groupId).toBe("0");
    expect(ex[4].groupId).toBe("0");
  });

  it("encodes distance targets in centimetres with the right display unit", () => {
    expect(ex[0].targetType).toBe(5);
    expect(ex[0].targetValue).toBe(200000); // 2000 m
    expect(ex[0].targetDisplayUnit).toBe(1); // km
    expect(ex[2].targetValue).toBe(80000); // 800 m
    expect(ex[2].targetDisplayUnit).toBe(2); // m
  });

  it("encodes duration targets in seconds", () => {
    expect(ex[3].targetType).toBe(2);
    expect(ex[3].targetValue).toBe(170);
    expect(ex[3].targetDisplayUnit).toBe(0);
  });

  it("stores the pace range fastest-first in milliseconds per km", () => {
    expect(ex[2].intensityType).toBe(3);
    expect(ex[2].intensityValue).toBe(280000); // 4:40
    expect(ex[2].intensityValueExtend).toBe(295000); // 4:55
  });

  it("normalises a reversed pace range", () => {
    const [seg] = buildRunExercises(
      [{ type: "work", distanceM: 400, paceFrom: "4:50", paceTo: "4:35" }],
      USER_ID
    );
    expect(seg.intensityValue).toBe(275000);
    expect(seg.intensityValueExtend).toBe(290000);
  });

  it("leaves the threshold percentages at 0 for the server to derive", () => {
    // The official web client sends 0 here and the server recomputes both from
    // the athlete's current threshold pace, overwriting whatever we send.
    for (const e of ex) {
      expect(e.intensityPercent).toBe(0);
      expect(e.intensityPercentExtend).toBe(0);
    }
  });

  it("tags everything as running", () => {
    expect(ex.every((e) => e.sportType === 1)).toBe(true);
  });

  it("assigns unique ids", () => {
    expect(new Set(ex.map((e) => e.id)).size).toBe(ex.length);
  });

  it("rejects a segment with both or neither target", () => {
    expect(() =>
      buildRunExercises(
        [{ type: "work", distanceM: 800, durationSec: 100, paceFrom: "4:00", paceTo: "4:10" }],
        USER_ID
      )
    ).toThrow(/exactly one of distanceM or durationSec/);
    expect(() =>
      buildRunExercises([{ type: "work", paceFrom: "4:00", paceTo: "4:10" }], USER_ID)
    ).toThrow(/exactly one of distanceM or durationSec/);
  });

  it("requires a pace range", () => {
    expect(() =>
      buildRunExercises([{ type: "work", distanceM: 800, paceFrom: "4:00" }], USER_ID)
    ).toThrow(/paceFrom and paceTo/);
  });

  it("rejects empty and nested repeats", () => {
    expect(() =>
      buildRunExercises([{ type: "repeat", times: 3, steps: [] }], USER_ID)
    ).toThrow(/at least one child step/);
    expect(() =>
      buildRunExercises(
        [
          {
            type: "repeat",
            times: 3,
            steps: [{ type: "repeat", times: 2, steps: [] } as never],
          },
        ],
        USER_ID
      )
    ).toThrow(/Nested repeat/);
  });

  it("rejects an empty workout", () => {
    expect(() => buildRunExercises([], USER_ID)).toThrow(/at least one step/);
  });
});

describe("buildRunWorkoutPayload", () => {
  it("sets the running sport type and reference block", () => {
    const p = buildRunWorkoutPayload(
      "Intervals",
      "",
      buildRunExercises(REFERENCE_STEPS, USER_ID)
    );
    expect(p.sportType).toBe(1);
    expect(p.estimatedType).toBe(6);
    expect(p.poolLength).toBe(0);
    expect(p.referExercise).toEqual({
      gradeSystem: 0,
      hrType: 3,
      intensityType: 0,
      valueType: 1,
    });
    expect(p.exercises).toHaveLength(5);
  });
});

describe("describeStep", () => {
  it("renders segments and repeats readably", () => {
    expect(describeStep(REFERENCE_STEPS[0])).toBe("warmup 2km @ 6:30-7:00/km");
    expect(describeStep(REFERENCE_STEPS[1])).toBe(
      "5x [ work 800m @ 4:40-4:55/km + recovery 2:50 @ 7:00-7:30/km ]"
    );
  });
});
