import { describe, expect, it } from "vitest";

import { mapInferenceToReleasePatch } from "@/workspaces/infer-workspace-settings.js";

describe("mapInferenceToReleasePatch", () => {
  it("should map supported expo inference to applyable patch", () => {
    const mapped = mapInferenceToReleasePatch({
      suggestedKind: "react_native_expo",
      confidence: "high",
      defaultBranch: "main",
      versionFilePath: "app.json",
      signals: [],
    });

    expect(mapped.canApply).toBe(true);
    expect(mapped.skipReason).toBeNull();
    expect(mapped.releaseProjectKind).toBe("react_native_expo");
    expect(mapped.releaseVersionFilePath).toBe("app.json");
    expect(mapped.releaseVersionBranch).toBe("main");
  });

  it("should skip unsupported kinds", () => {
    const mapped = mapInferenceToReleasePatch({
      suggestedKind: "flutter_pubspec",
      confidence: "high",
      defaultBranch: "main",
      versionFilePath: "pubspec.yaml",
      signals: [],
    });

    expect(mapped.canApply).toBe(false);
    expect(mapped.skipReason).toBe("unsupported_release_kind");
  });

  it("should skip when version file is missing", () => {
    const mapped = mapInferenceToReleasePatch({
      suggestedKind: "react_native_expo",
      confidence: "low",
      defaultBranch: "develop",
      versionFilePath: null,
      signals: [],
    });

    expect(mapped.canApply).toBe(false);
    expect(mapped.skipReason).toBe("missing_version_file");
    expect(mapped.releaseVersionBranch).toBe("develop");
  });
});
