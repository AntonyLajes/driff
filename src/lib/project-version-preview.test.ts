import { describe, expect, it } from "vitest";

import { parseProjectVersionPreview } from "@/lib/project-version-preview.js";

describe("lib/project-version-preview", () => {
  it("previews Expo and Node versions", () => {
    expect(
      parseProjectVersionPreview(
        "react_native_expo",
        "app.json",
        JSON.stringify({ expo: { version: "1.3.4", ios: { buildNumber: "6" } } }),
      ),
    ).toEqual({ short: "1.3.4", build: "6" });
    expect(
      parseProjectVersionPreview("node_package", "package.json", '{"version":"2.1.0"}'),
    ).toEqual({ short: "2.1.0", build: "" });
  });

  it("previews native and ecosystem marker files", () => {
    expect(
      parseProjectVersionPreview(
        "android_gradle",
        "android/app/build.gradle",
        'versionCode 47\nversionName "3.2.1"',
      ),
    ).toEqual({ short: "3.2.1", build: "47" });
    expect(
      parseProjectVersionPreview("python_pyproject", "pyproject.toml", '[project]\nversion="0.8.0"'),
    ).toEqual({ short: "0.8.0", build: "" });
  });

  it("returns null when the selected file cannot provide a version", () => {
    expect(parseProjectVersionPreview("rust_cargo", "Cargo.toml", "[workspace]"))
      .toBeNull();
  });
});
