import { describe, expect, it } from "vitest";

import { execute } from "@/lib/package-json-version.js";

describe("lib/package-json-version", () => {
  it("reads and trims the package version", () => {
    expect(execute('{"name":"app","version":" 2.4.1 "}')).toEqual({
      short: "2.4.1",
      build: "",
    });
  });

  it("rejects invalid or unversioned package files", () => {
    expect(execute('{"name":"app"}')).toBeNull();
    expect(execute('{"version":42}')).toBeNull();
    expect(execute('{"version":"   "}')).toBeNull();
    expect(execute("not-json")).toBeNull();
  });
});
