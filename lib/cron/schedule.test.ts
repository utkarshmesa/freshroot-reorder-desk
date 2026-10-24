// Crons, pure part (ARCHITECTURE §4.1, §10): deadline timing (D8, C-024), stale drafts (C-009),
// rejection-rate alarm, missed upload, alert recipients.
import { describe, expect, it } from "vitest";
import { deadlineDue, deadlineFor, isStale, recipientsFor, rejectionAlarm, uploadDue } from "./schedule";

const TUE_NOON = { weekday: "TUE", timeIST: "12:00" };

describe("deadline (D8, C-024)", () => {
  it("is Tuesday 12:00 IST of the run week (06:30 UTC), W53 included", () => {
    expect(deadlineFor("2026-W43", TUE_NOON).toISOString()).toBe("2026-10-20T06:30:00.000Z");
    expect(deadlineFor("2026-W53", TUE_NOON).toISOString()).toBe("2026-12-29T06:30:00.000Z");
    expect(deadlineFor("2027-W01", TUE_NOON).toISOString()).toBe("2027-01-05T06:30:00.000Z");
  });

  it("applies at the first noon firing at or after the deadline, once the run is ready", () => {
    const run = { isoWeek: "2026-W43", readyAt: "2026-10-19T04:00:00Z" };
    expect(deadlineDue(run, new Date("2026-10-20T06:29:00Z"), TUE_NOON)).toBe(false);
    expect(deadlineDue(run, new Date("2026-10-20T06:30:00Z"), TUE_NOON)).toBe(true);
  });

  it("C-024: a run ready after Tue 12:00 waits for the next noon firing (Wed 12:00)", () => {
    const late = { isoWeek: "2026-W43", readyAt: "2026-10-20T07:00:00Z" }; // Tue 12:30 IST
    expect(deadlineDue(late, new Date("2026-10-20T06:30:00Z"), TUE_NOON)).toBe(false); // the Tue firing ran before it was ready
    expect(deadlineDue(late, new Date("2026-10-21T06:30:00Z"), TUE_NOON)).toBe(true);
  });

  it("never before the run is ready", () => {
    expect(deadlineDue({ isoWeek: "2026-W43", readyAt: null }, new Date("2026-10-22T06:30:00Z"), TUE_NOON)).toBe(false);
  });
});

describe("stale drafts (C-009)", () => {
  it("a live draft created more than draftStaleDays ago and still unissued needs re-approval", () => {
    const now = new Date("2026-10-24T06:30:00Z");
    expect(isStale({ createdAt: "2026-10-20T06:31:00Z", status: "created", mode: "live", needsReapproval: false }, now, 3)).toBe(true);
    expect(isStale({ createdAt: "2026-10-22T06:31:00Z", status: "created", mode: "live", needsReapproval: false }, now, 3)).toBe(false);
    expect(isStale({ createdAt: "2026-10-20T06:31:00Z", status: "issued", mode: "live", needsReapproval: false }, now, 3)).toBe(false);
    expect(isStale({ createdAt: "2026-10-20T06:31:00Z", status: "created", mode: "live", needsReapproval: true }, now, 3)).toBe(false); // already flagged
  });
});

describe("rejection-rate alarm (unit-weighted, ARCHITECTURE §8)", () => {
  const alarm = { lowPct: 5, highPct: 40 };
  it("below 5% raises the alarm (rubber-stamping)", () => {
    expect(rejectionAlarm([{ state: "approved", units: 1000 }, { state: "rejected", units: 40 }], alarm)).toEqual({ ratePct: 3.8, level: "low" });
  });
  it("above 40% raises it too", () => {
    expect(rejectionAlarm([{ state: "approved", units: 100 }, { state: "rejected", units: 100 }], alarm)).toEqual({ ratePct: 50, level: "high" });
  });
  it("in between is fine; nothing decided is no alarm", () => {
    expect(rejectionAlarm([{ state: "approved", units: 90 }, { state: "changed", units: 0 }, { state: "rejected", units: 10 }], alarm).level).toBeNull();
    expect(rejectionAlarm([], alarm)).toEqual({ ratePct: null, level: null });
  });
});

describe("missed upload (Mon 10:00 IST)", () => {
  it("due when nothing was committed since Monday 00:00 IST of this week", () => {
    const now = new Date("2026-10-19T04:30:00Z"); // Mon 10:00 IST
    expect(uploadDue(now, null)).toBe(true);
    expect(uploadDue(now, "2026-10-19T02:00:00Z")).toBe(false); // Mon 07:30 IST
    expect(uploadDue(now, "2026-10-18T18:30:00Z")).toBe(false); // exactly Mon 00:00 IST counts
    expect(uploadDue(now, "2026-10-18T18:00:00Z")).toBe(true); // Sun 23:30 IST: last week
    expect(uploadDue(now, "2026-10-12T03:00:00Z")).toBe(true); // last week's
  });
});

describe("alert recipients (§10)", () => {
  const users = [
    { email: "priya@x", roles: ["uploader"], isOwner: false, backupFor: null, backupFrom: null, backupTo: null },
    { email: "sam@x", roles: ["uploader"], isOwner: false, backupFor: "uploader", backupFrom: "2026-10-01", backupTo: "2026-10-31" },
    { email: "raghav@x", roles: ["planner"], isOwner: false, backupFor: null, backupFrom: null, backupTo: null },
    { email: "deepa@x", roles: ["planner", "admin"], isOwner: true, backupFor: null, backupFrom: null, backupTo: null },
    { email: "proc@x", roles: ["procurement"], isOwner: false, backupFor: null, backupFrom: null, backupTo: null },
    { email: "it@x", roles: ["admin"], isOwner: false, backupFor: null, backupFrom: null, backupTo: null },
  ];
  const day = "2026-10-19";
  it("routes each kind", () => {
    expect(recipientsFor("pending_draft", users, day)).toEqual(["deepa@x", "proc@x", "raghav@x"]);
    expect(recipientsFor("draft_stale", users, day)).toEqual(["deepa@x", "proc@x", "raghav@x"]);
    expect(recipientsFor("deadline_applied", users, day)).toEqual(["deepa@x"]);
    expect(recipientsFor("rejection_rate", users, day)).toEqual(["deepa@x"]);
    expect(recipientsFor("upload_missed", users, day)).toEqual(["deepa@x", "raghav@x", "sam@x"]);
    expect(recipientsFor("run_blocked", users, day)).toEqual(["deepa@x", "it@x", "priya@x", "raghav@x", "sam@x"]);
    expect(recipientsFor("llm_fallback", users, day)).toEqual(["deepa@x", "it@x"]);
  });
  it("a backup outside their dates isn't alerted for the missed upload", () => {
    expect(recipientsFor("upload_missed", users, "2026-11-02")).toEqual(["deepa@x", "raghav@x"]);
  });
});
