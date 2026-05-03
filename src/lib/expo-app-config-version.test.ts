import { describe, expect, it } from "vitest";

import { execute } from "@/lib/expo-app-config-version.js";

describe("lib/expo-app-config-version execute", () => {
  it("should parse app.json expo version and ios buildNumber", () => {
    const json = JSON.stringify({
      expo: { version: "2.1.0", ios: { buildNumber: "99" }, android: { versionCode: 100 } },
    });
    const v = execute(json, "app.json");
    expect(v).toEqual({ short: "2.1.0", build: "99" });
  });

  it("should use android versionCode when ios buildNumber missing", () => {
    const json = JSON.stringify({
      expo: { version: "1.0.0", android: { versionCode: 42 } },
    });
    expect(execute(json, "app.config.json")).toEqual({ short: "1.0.0", build: "42" });
  });

  it("should parse static app.config.js export default", () => {
    const js = `export default { expo: { name: "x", version: "3.0.1", ios: { buildNumber: "7" } } };`;
    expect(execute(js, "app.config.js")).toEqual({ short: "3.0.1", build: "7" });
  });

  it("should return null for invalid json", () => {
    expect(execute("{", "app.json")).toBeNull();
  });

  it("should return null when expo version keys missing", () => {
    expect(execute(JSON.stringify({ name: "x" }), "app.json")).toBeNull();
  });

  it("should return null when expo object has wrong shape", () => {
    expect(execute(JSON.stringify({ expo: "invalid" }), "app.json")).toBeNull();
  });

  it("should parse marketing version without native build in app.json", () => {
    expect(execute(JSON.stringify({ expo: { version: "4.0.0" } }), "app.json")).toEqual({
      short: "4.0.0",
      build: "",
    });
  });

  it("should parse app.config.tsx", () => {
    const ts = `export default { expo: { version: "2", ios: { buildNumber: "1" } } };`;
    expect(execute(ts, "app.config.tsx")).toEqual({ short: "2", build: "1" });
  });

  it("should parse app.config.mjs with android versionCode", () => {
    const m = `export default { expo: { version: "5", android: { versionCode: 9 } } };`;
    expect(execute(m, "app.config.mjs")).toEqual({ short: "5", build: "9" });
  });

  it("should strip block comments before regex parse", () => {
    const js = `export default { expo: { /* x */ version: "6", ios: { buildNumber: "2" } } };`;
    expect(execute(js, "app.config.js")).toEqual({ short: "6", build: "2" });
  });

  it("should treat unknown extension as config module text", () => {
    const raw = `export default { expo: { version: "8" } };`;
    expect(execute(raw, "babel.config.cjs")).toEqual({ short: "8", build: "" });
  });
});
