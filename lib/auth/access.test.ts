import { describe, expect, it } from "vitest";
import { can, canSee, homeFor, type Me, type Screen } from "./access";

const priya: Me = { roles: ["uploader"], isOwner: false };
const raghav: Me = { roles: ["planner"], isOwner: false };
const procurement: Me = { roles: ["procurement"], isOwner: false };
const itAdmin: Me = { roles: ["admin", "uploader"], isOwner: false };
const deepa: Me = { roles: ["planner", "admin"], isOwner: true };
const ceo: Me = { roles: ["viewer"], isOwner: false };

describe("ST-06 screens per role (UI part)", () => {
  const visible = (me: Me) => (["upload", "review", "settings", "outcomes", "instructions"] as Screen[]).filter((s) => canSee(me, s));

  it.each([
    ["Priya (uploader)", priya, ["upload", "instructions"]],
    ["Raghav (planner)", raghav, ["review", "settings", "outcomes", "instructions"]],
    ["Procurement", procurement, ["review", "settings", "outcomes", "instructions"]],
    ["IT admin", itAdmin, ["upload", "review", "settings", "outcomes", "instructions"]],
    ["CEO (viewer)", ceo, ["outcomes", "instructions"]],
  ] as Array<[string, Me, Screen[]]>)("%s sees %j", (_, me, screens) => {
    expect(visible(me)).toEqual(screens);
  });
});

describe("actions per role", () => {
  it("procurement is read-only in the app (C-013)", () => {
    expect(can(procurement, "settings.editMaster")).toBe(false);
    expect(can(procurement, "review.decide")).toBe(false);
  });

  it("only the owner switches mode or the holdout, and only as admin", () => {
    expect(can(deepa, "owner.setMode")).toBe(true);
    expect(can(itAdmin, "owner.setMode")).toBe(false);
    expect(can(raghav, "owner.setHoldout")).toBe(false);
    expect(can({ roles: ["planner"], isOwner: true }, "owner.setMode")).toBe(false);
  });

  it("only the planner publishes rules and decides cards; only uploaders commit", () => {
    expect(can(raghav, "settings.publishRules")).toBe(true);
    expect(can(itAdmin, "settings.publishRules")).toBe(false);
    expect(can(raghav, "review.decide")).toBe(true);
    expect(can(priya, "upload.commit")).toBe(true);
    expect(can(raghav, "upload.commit")).toBe(false);
  });

  it("lands each role on its main screen", () => {
    expect([priya, raghav, procurement, itAdmin, deepa, ceo].map(homeFor)).toEqual(["/upload", "/review", "/review", "/upload", "/review", "/outcomes"]);
  });
});
