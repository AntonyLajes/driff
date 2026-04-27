import { describe, expect, it } from "vitest";

import { execute, toVersionKey } from "@/lib/plist-version.js";

describe("lib/plist-version execute", () => {
  it("should parse short and build from xml plist", () => {
    const raw = `<?xml version="1.0"?>
<plist>
<dict>
<key>CFBundleShortVersionString</key>
<string>2.1.0</string>
<key>CFBundleVersion</key>
<string>120</string>
</dict>
</plist>`;
    const result = execute(raw);
    expect(result).toEqual({ short: "2.1.0", build: "120" });
    expect(toVersionKey(result!)).toBe("2.1.0+120");
  });

  it("should return null when no version keys found", () => {
    const result = execute("<dict></dict>");
    expect(result).toBeNull();
  });

  it("toVersionKey should handle partial versions", () => {
    expect(toVersionKey({ short: "1.0", build: "" })).toBe("1.0");
    expect(toVersionKey({ short: "", build: "99" })).toBe("99");
  });
});
