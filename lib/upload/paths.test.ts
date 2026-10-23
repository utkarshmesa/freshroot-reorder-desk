import { describe, expect, it } from "vitest";
import { isOwnUploadPath, safeFileName } from "./paths";

const me = "00000000-0000-4000-a000-000000000001";
const other = "00000000-0000-4000-a000-000000000002";
const batch = "4f6d7a3e-1b2c-4d5e-8f90-123456789abc";

describe("upload storage paths", () => {
  it("accepts the caller's own file", () => {
    expect(isOwnUploadPath(`${me}/${batch}/weekly_sales (1).csv`, me)).toBe(true);
  });

  it.each([
    [`${other}/${batch}/sales.csv`, "someone else's folder"],
    [`${me}/../${other}/${batch}/sales.csv`, "dot-dot traversal"],
    [`${me}/${batch}/..`, "dot-dot file name"],
    [`${me}/${batch}/%2e%2e/x.csv`, "percent-encoded traversal"],
    [`${me}/${batch}/a/b.csv`, "extra folder"],
    [`${me}/${batch}/a\\b.csv`, "backslash"],
    [`${me}/not-a-batch/sales.csv`, "bad batch id"],
    [`/${me}/${batch}/sales.csv`, "leading slash"],
  ])("rejects %s (%s)", (p) => {
    expect(isOwnUploadPath(p, me)).toBe(false);
  });

  it("makes any file name safe", () => {
    expect(safeFileName("Sales W44 [final]#2.csv")).toBe("Sales W44 _final__2.csv");
    expect(isOwnUploadPath(`${me}/${batch}/${safeFileName("..evil../x.csv")}`, me)).toBe(true);
  });
});
