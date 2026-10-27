import { describe, it, expect } from "vitest";
import {
  toApiDate,
  pickScheduledEntity,
  buildReplaceScheduleBody,
} from "../coros-api.js";
import type { ScheduleEntity } from "../types.js";

describe("toApiDate", () => {
  it("accepts YYYY-MM-DD and YYYYMMDD", () => {
    expect(toApiDate("2026-09-08")).toBe("20260908");
    expect(toApiDate("20260908")).toBe("20260908");
  });

  it("rejects anything else", () => {
    expect(() => toApiDate("2026-9-8")).toThrow(/Invalid date/);
    expect(() => toApiDate("08/09/2026")).toThrow(/Invalid date/);
    expect(() => toApiDate("")).toThrow(/Invalid date/);
  });
});

describe("pickScheduledEntity", () => {
  const day = "20261104";
  const one: ScheduleEntity = { happenDay: day, idInPlan: 7, sortNoInSchedule: 1 };
  const two: ScheduleEntity = { happenDay: day, idInPlan: 8, sortNoInSchedule: 2 };
  const otherDay: ScheduleEntity = {
    happenDay: "20261105",
    idInPlan: 9,
    sortNoInSchedule: 1,
  };

  it("picks the only workout on the day", () => {
    expect(pickScheduledEntity([one, otherDay], day).idInPlan).toBe(7);
  });

  it("picks by slot when the day has several", () => {
    expect(pickScheduledEntity([one, two], day, 2).idInPlan).toBe(8);
  });

  it("refuses to guess between two workouts on one day", () => {
    expect(() => pickScheduledEntity([one, two], day)).toThrow(/pass sortNoInSchedule/);
  });

  it("reports an empty day and a missing slot", () => {
    expect(() => pickScheduledEntity([otherDay], day)).toThrow(/Nothing is scheduled/);
    expect(() => pickScheduledEntity([one], day, 3)).toThrow(/No workout with sortNoInSchedule 3/);
  });
});

describe("buildReplaceScheduleBody", () => {
  const entity: ScheduleEntity = {
    happenDay: "20261104",
    idInPlan: 7,
    sortNoInSchedule: 1,
  };
  const program = {
    id: "481327250128683207",
    name: "Easy by HR",
    pbVersion: 2,
    exercises: [{ id: "1", intensityPercent: 66000, intensityPercentExtend: 78000 }],
  };

  it("edits the existing slot instead of adding one", () => {
    const body = buildReplaceScheduleBody(entity, program) as {
      entities: ScheduleEntity[];
      programs: Record<string, unknown>[];
      versionObjects: Record<string, unknown>[];
      pbVersion: number;
    };
    // status 2 = edit in place (1 adds a slot, 3 deletes one)
    expect(body.versionObjects).toEqual([{ id: 7, status: 2 }]);
    expect(body.entities).toEqual([entity]);
    // the new workout takes over the slot's idInPlan, so the day keeps its place
    expect(body.programs[0].idInPlan).toBe(7);
    expect(body.programs[0].name).toBe("Easy by HR");
    expect(body.pbVersion).toBe(2);
  });

  it("zeroes the intensity percentages for the server to recompute", () => {
    const body = buildReplaceScheduleBody(entity, program) as {
      programs: { exercises: Record<string, unknown>[] }[];
    };
    expect(body.programs[0].exercises[0]).toMatchObject({
      intensityPercent: 0,
      intensityPercentExtend: 0,
    });
  });

  it("echoes a plan slot's ids back", () => {
    const planned: ScheduleEntity = { ...entity, planId: "42", planProgramId: "99" };
    const body = buildReplaceScheduleBody(planned, program) as {
      versionObjects: Record<string, unknown>[];
    };
    expect(body.versionObjects[0]).toEqual({
      id: 7,
      status: 2,
      planProgramId: "99",
      planId: "42",
    });
  });
});
