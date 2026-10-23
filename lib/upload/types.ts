// Upload contract types (BUILD_PLAN §7, ARCHITECTURE §7). Pure.

export type FileKind =
  | "sales_weekly"
  | "stock_snapshot"
  | "sku_master"
  | "distributor_master"
  | "case_sku_master"
  | "case_distributor_master"
  | "case_weekly_sales"
  | "case_inventory"
  | "case_calendar";

export type IssueLevel = "error" | "confirm" | "warning" | "info";

export type Issue = {
  level: IssueLevel;
  code: string;
  message: string;
  file?: string;
  row?: number; // 1-based data row (header excluded)
  link?: string; // Instructions section that explains what to do
};

export type ParsedTable = {
  name: string;
  headers: string[]; // normalised: trimmed, lower-case, BOM stripped
  rows: Array<Record<string, string>>; // every cell as a string
};

export type InputFile = {
  name: string;
  hash: string; // sha256 hex of the raw bytes, computed by the caller
  table: ParsedTable;
};

export type StagingKind = "sales" | "stock" | "sku" | "distributor" | "supplier" | "festival";
export type StagingRow = { kind: StagingKind; row: Record<string, string | number | boolean | null> };

export type UploadContext = {
  caseDataMode: boolean;
  knownSkuIds: ReadonlySet<string>;
  activeSkuIds?: ReadonlySet<string>; // defaults to knownSkuIds
  knownDistributorIds: ReadonlySet<string>;
  knownSupplierIds: ReadonlySet<string>;
  committedHashes: ReadonlySet<string>;
  latestCommittedWeek: string | null;
  currentRunWeek?: string | null; // week of the latest (non-superseded) run
  lastAsOf: string | null; // ISO timestamp of the last committed stock snapshot
  previousWeekNetUnits: number | null; // total net units of latestCommittedWeek
  rules: { restatementWindowWks: number; volumeChangeConfirmPct: number; festivalUpliftPct: number; festivalPreloadWks: number };
};

export type Report = {
  issues: Issue[];
  errors: number;
  confirms: number;
  unconfirmed: number;
  warnings: number;
  kinds: FileKind[];
  newWeeks: string[];
  restatedWeeks: string[];
  asOf: string | null;
  banner: string | null;
  counts: Partial<Record<StagingKind, number>>;
};

export type PreparedUpload = {
  report: Report;
  staging: StagingRow[];
  hashes: string[];
  files: string[];
};
