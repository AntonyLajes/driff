import { describe, expect, it } from "vitest";

import {
  cleanHistoryFilterValues,
  filterHistoryDiff,
  filterHistoryFileSummary,
  isHistoryActorExcluded,
  isHistoryPathExcluded,
} from "@/config/history-content-filter.js";

describe("config/history-content-filter", () => {
  it("matches exact files, directories, basenames and globs", () => {
    const patterns = ["package-lock.json", "dist/", "*.generated.*", "docs/**/*.md"];
    expect(isHistoryPathExcluded("apps/web/package-lock.json", patterns)).toBe(true);
    expect(isHistoryPathExcluded("dist/client.js", patterns)).toBe(true);
    expect(isHistoryPathExcluded("src/api.generated.ts", patterns)).toBe(true);
    expect(isHistoryPathExcluded("docs/guides/start.md", patterns)).toBe(true);
    expect(isHistoryPathExcluded("src/features/home.ts", patterns)).toBe(false);
  });

  it("filters excluded file sections before a diff reaches the LLM", () => {
    const diff = [
      "diff --git a/package-lock.json b/package-lock.json\n+lock",
      "diff --git a/src/home.ts b/src/home.ts\n+feature",
    ].join("\n");
    expect(filterHistoryDiff(diff, ["package-lock.json"])).toBe(
      "diff --git a/src/home.ts b/src/home.ts\n+feature",
    );
  });

  it("filters file summaries and compares actors case-insensitively", () => {
    expect(
      filterHistoryFileSummary(
        "modified: package-lock.json\nadded: src/home.ts",
        ["package-lock.json"],
      ),
    ).toBe("added: src/home.ts");
    expect(isHistoryActorExcluded("Dependabot[bot]", ["dependabot[bot]"])).toBe(true);
  });

  it("cleans values while preserving an explicit empty list", () => {
    expect(cleanHistoryFilterValues([" dist/ ", "dist/", ""])).toEqual(["dist/"]);
    expect(cleanHistoryFilterValues([])).toEqual([]);
    expect(cleanHistoryFilterValues(null)).toBeNull();
  });
});
