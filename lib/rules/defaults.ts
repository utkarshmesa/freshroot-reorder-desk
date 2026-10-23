// Rule parameters (rule_version.params). The seed inserts exactly these as version 1,
// and the Instructions page binds every ⚙ value to the current version (ST-07).
// Sources: CASE_CONTEXT (Raghav's rules), BUILD_PLAN D1–D18, CHANGES C-001…C-027.

export type RuleParams = {
  bands: {
    nonPerishable: { minWks: number; maxWks: number };
    perishable: { minWks: number; maxWks: number; maxShelfLifeFraction: number };
  };
  leadTimeBufferWks: number;
  highDemandRatio: number;
  highDemandMultiplier: number;
  festivalUpliftPct: number;
  festivalPreloadWks: number;
  avgLongWks: number;
  avgShortWks: number;
  minCleanWeeks: number;
  lookbackWks: number;
  borderlinePct: number;
  autoApproveMaxStdMultiple: number;
  deadlineStdMultiple: number;
  spotChecks: number;
  restatementWindowWks: number;
  volumeChangeConfirmPct: number;
  newSku: { launchEstimateWks: number; blendUntilWk: number };
  newDistributor: { ignoreWks: number; noTrendUntilWk: number };
  defaults: { leadTimeWks: number; moq: "std"; perishableMaxWks: number };
  rejectionAlarm: { lowPct: number; highPct: number };
  draftStaleDays: number;
  deadline: { weekday: "TUE"; timeIST: string };
};

export const DEFAULT_RULES: RuleParams = {
  bands: {
    nonPerishable: { minWks: 6, maxWks: 14 },
    perishable: { minWks: 3, maxWks: 4, maxShelfLifeFraction: 0.5 },
  },
  leadTimeBufferWks: 2,
  highDemandRatio: 1.2,
  highDemandMultiplier: 1.5,
  festivalUpliftPct: 25,
  festivalPreloadWks: 3,
  avgLongWks: 12,
  avgShortWks: 4,
  minCleanWeeks: 8,
  lookbackWks: 26,
  borderlinePct: 5,
  autoApproveMaxStdMultiple: 2,
  deadlineStdMultiple: 1,
  spotChecks: 5,
  restatementWindowWks: 12,
  volumeChangeConfirmPct: 40,
  newSku: { launchEstimateWks: 4, blendUntilWk: 12 },
  newDistributor: { ignoreWks: 4, noTrendUntilWk: 12 },
  defaults: { leadTimeWks: 2, moq: "std", perishableMaxWks: 4 },
  rejectionAlarm: { lowPct: 5, highPct: 40 },
  draftStaleDays: 3,
  deadline: { weekday: "TUE", timeIST: "12:00" },
};

export const DEFAULT_REASON_CODES: ReadonlyArray<{ code: string; label: string }> = [
  { code: "disagree_rule", label: "Disagree with the rule" },
  { code: "event_not_in_holds", label: "Known event not in holds" },
  { code: "supplier_issue", label: "Supplier issue" },
  { code: "stock_data_wrong", label: "Stock data wrong" },
  { code: "other", label: "Other" },
];
