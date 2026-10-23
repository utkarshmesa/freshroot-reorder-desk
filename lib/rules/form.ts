// Editable rule fields with plain-English labels, shared by the Settings form and (later) the Instructions bindings.
import type { RuleParams } from "./defaults";

export type RuleField = { path: string; label: string; unit: string; min: number; max: number; integer?: boolean };

export const RULE_FIELDS: RuleField[] = [
  { path: "bands.nonPerishable.minWks", label: "Normal SKUs: minimum cover", unit: "weeks", min: 1, max: 52 },
  { path: "bands.nonPerishable.maxWks", label: "Normal SKUs: maximum cover", unit: "weeks", min: 1, max: 52 },
  { path: "bands.perishable.minWks", label: "Perishables: minimum cover", unit: "weeks", min: 0.5, max: 26 },
  { path: "bands.perishable.maxWks", label: "Perishables: maximum cover", unit: "weeks", min: 0.5, max: 26 },
  { path: "bands.perishable.maxShelfLifeFraction", label: "Perishables: maximum as a share of shelf life", unit: "×", min: 0.1, max: 1 },
  { path: "leadTimeBufferWks", label: "Minimum cover is at least lead time plus", unit: "weeks", min: 0, max: 12 },
  { path: "highDemandRatio", label: "High demand: last 4 weeks above the 12-week average by more than", unit: "× (1.20 = 20%)", min: 1, max: 3 },
  { path: "highDemandMultiplier", label: "High demand: order this many times the standard quantity", unit: "×", min: 1, max: 5 },
  { path: "festivalUpliftPct", label: "Festival uplift on forward demand", unit: "%", min: 0, max: 200 },
  { path: "festivalPreloadWks", label: "Festival pre-load window", unit: "weeks", min: 0, max: 8, integer: true },
  { path: "borderlinePct", label: "Borderline: cover within this much of a band edge", unit: "%", min: 0, max: 50 },
  { path: "autoApproveMaxStdMultiple", label: "Auto-approve limit", unit: "× standard qty", min: 1, max: 10 },
  { path: "deadlineStdMultiple", label: "Tuesday 12:00 rule orders", unit: "× standard qty", min: 0, max: 5 },
  { path: "spotChecks", label: "Spot-checks per week", unit: "cards", min: 0, max: 50, integer: true },
  { path: "minCleanWeeks", label: "Fewer clean weeks than this go to the queue", unit: "weeks", min: 1, max: 26, integer: true },
  { path: "restatementWindowWks", label: "Corrections allowed for the last", unit: "weeks", min: 1, max: 52, integer: true },
  { path: "volumeChangeConfirmPct", label: "Upload volume change that needs a confirm", unit: "%", min: 1, max: 500 },
  { path: "defaults.leadTimeWks", label: "Assumed lead time when missing", unit: "weeks", min: 0, max: 26 },
  { path: "defaults.perishableMaxWks", label: "Assumed perishable maximum when shelf life is missing", unit: "weeks", min: 0.5, max: 26 },
  { path: "newSku.launchEstimateWks", label: "New SKU: use the launch estimate for the first", unit: "weeks", min: 0, max: 26, integer: true },
  { path: "newSku.blendUntilWk", label: "New SKU: blend estimate and actuals until week", unit: "", min: 1, max: 52, integer: true },
  { path: "newDistributor.ignoreWks", label: "New distributor: ignore the first", unit: "weeks", min: 0, max: 26, integer: true },
  { path: "newDistributor.noTrendUntilWk", label: "New distributor: leave out of the high-demand check until week", unit: "", min: 0, max: 52, integer: true },
  { path: "rejectionAlarm.lowPct", label: "Alarm if rejection rate is below", unit: "%", min: 0, max: 100 },
  { path: "rejectionAlarm.highPct", label: "Alarm if rejection rate is above", unit: "%", min: 0, max: 100 },
  { path: "draftStaleDays", label: "Alert on drafts not issued after", unit: "days", min: 1, max: 30, integer: true },
];

export function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function setPath<T>(obj: T, path: string, value: unknown): T {
  const copy = structuredClone(obj) as Record<string, unknown>;
  const keys = path.split(".");
  let o = copy;
  for (const k of keys.slice(0, -1)) o = o[k] as Record<string, unknown>;
  o[keys.at(-1)!] = value;
  return copy as T;
}

export type FormResult = { ok: true; params: RuleParams; changed: string[] } | { ok: false; error: string };

/** Applies submitted form values to the current params, with range checks. Pure. */
export function applyRuleForm(current: RuleParams, form: { get(name: string): FormDataEntryValue | null }): FormResult {
  let params = current;
  const changed: string[] = [];
  for (const f of RULE_FIELDS) {
    const raw = String(form.get(f.path) ?? "").trim();
    if (raw === "") continue;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < f.min || v > f.max) return { ok: false, error: `${f.label}: must be between ${f.min} and ${f.max}` };
    if (f.integer && !Number.isInteger(v)) return { ok: false, error: `${f.label}: must be a whole number` };
    if (getPath(params, f.path) !== v) {
      params = setPath(params, f.path, v);
      changed.push(f.label);
    }
  }
  const b = params.bands;
  if (b.nonPerishable.minWks > b.nonPerishable.maxWks) return { ok: false, error: "Normal SKUs: minimum cover can't be above the maximum" };
  if (b.perishable.minWks > b.perishable.maxWks) return { ok: false, error: "Perishables: minimum cover can't be above the maximum" };
  if (params.rejectionAlarm.lowPct >= params.rejectionAlarm.highPct) return { ok: false, error: "Rejection alarm: the low threshold must be below the high one" };
  return { ok: true, params, changed };
}
