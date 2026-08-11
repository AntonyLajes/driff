import { describe, expect, it } from "vitest";

import { parseVersionMarkerFile } from "@/lib/version-marker-file.js";

describe("lib/version-marker-file", () => {
  it("reads Python PEP 621 and Poetry versions", () => {
    expect(
      parseVersionMarkerFile(
        "python_pyproject",
        '[project]\nversion = "1.4.0"',
      ),
    ).toEqual({ short: "1.4.0", build: "" });
    expect(
      parseVersionMarkerFile(
        "python_pyproject",
        "[tool.poetry]\nversion = '2.0.1'",
      ),
    ).toEqual({ short: "2.0.1", build: "" });
  });

  it("reads Rust, Flutter and Android versions", () => {
    expect(
      parseVersionMarkerFile("rust_cargo", '[package]\nversion = "0.9.2"'),
    ).toEqual({ short: "0.9.2", build: "" });
    expect(
      parseVersionMarkerFile("flutter_pubspec", "name: app\nversion: 3.2.1+47"),
    ).toEqual({ short: "3.2.1", build: "47" });
    expect(
      parseVersionMarkerFile(
        "android_gradle",
        'versionCode 18\nversionName "2.5.0"',
      ),
    ).toEqual({ short: "2.5.0", build: "18" });
  });

  it("reads Maven and Gradle versions without taking the Maven parent", () => {
    const pom =
      "<project><parent><version>9.9.9</version></parent><version>1.2.3</version></project>";
    expect(parseVersionMarkerFile("java_maven", pom)).toEqual({
      short: "1.2.3",
      build: "",
    });
    expect(parseVersionMarkerFile("java_gradle", "version = '4.1.0'")).toEqual({
      short: "4.1.0",
      build: "",
    });
  });

  it("returns null for missing or unsupported markers", () => {
    expect(
      parseVersionMarkerFile("rust_cargo", "[workspace]\nmembers = []"),
    ).toBeNull();
    expect(parseVersionMarkerFile("unknown", 'version = "1"')).toBeNull();
  });
});
