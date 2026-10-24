// Which role sees which screen and may take which action (D19, ARCHITECTURE §3.2, ST-06).
// Pure. The database (RLS + RPC role checks) is the real guard; this keeps the UI in line with it.

export type Role = "uploader" | "planner" | "procurement" | "admin" | "viewer";
export type Screen = "upload" | "review" | "settings" | "outcomes" | "instructions";
export type Action =
  | "upload.commit"
  | "settings.editMaster"
  | "settings.editEvents"
  | "settings.publishRules"
  | "settings.editPeople"
  | "settings.editReasonCodes"
  | "owner.setMode"
  | "owner.setHoldout"
  | "review.decide"
  | "run.retry"
  | "sheet.confirm";

export type Me = { roles: Role[]; isOwner: boolean };

const SCREENS: Record<Screen, Role[]> = {
  upload: ["uploader", "admin"],
  review: ["planner", "procurement", "admin"],
  settings: ["planner", "procurement", "admin"],
  outcomes: ["planner", "procurement", "admin", "viewer"],
  instructions: ["uploader", "planner", "procurement", "admin", "viewer"],
};

const ACTIONS: Record<Action, Role[]> = {
  "upload.commit": ["uploader"],
  "settings.editMaster": ["planner", "admin"],
  "settings.editEvents": ["planner"],
  "settings.publishRules": ["planner"],
  "settings.editPeople": ["admin"],
  "settings.editReasonCodes": ["admin"],
  "owner.setMode": [],
  "owner.setHoldout": [],
  "review.decide": ["planner"],
  "run.retry": ["admin"],
  "sheet.confirm": ["procurement", "planner"],
};

const has = (me: Me, roles: Role[]) => me.roles.some((r) => roles.includes(r));

export function canSee(me: Me, screen: Screen): boolean {
  return has(me, SCREENS[screen]);
}

export function can(me: Me, action: Action): boolean {
  if (action === "owner.setMode" || action === "owner.setHoldout") return me.isOwner && me.roles.includes("admin");
  return has(me, ACTIONS[action]);
}

export const SCREEN_ORDER: Screen[] = ["upload", "review", "settings", "outcomes", "instructions"];

/** Where a user lands after signing in. */
export function homeFor(me: Me): string {
  if (me.roles.includes("planner")) return "/review";
  if (me.roles.includes("uploader")) return "/upload";
  if (me.roles.includes("procurement")) return "/review";
  if (me.roles.includes("admin")) return "/settings";
  if (me.roles.includes("viewer")) return "/outcomes";
  return "/instructions";
}
