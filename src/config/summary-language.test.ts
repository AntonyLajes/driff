import { describe, expect, it } from "vitest";

import { execute } from "@/config/summary-language.js";

describe("config/summary-language", () => {
  it.each(["auto", "en", "pt-BR"])("should preserve supported language %s", (language) => {
    expect(execute(language)).toBe(language);
  });

  it.each([null, undefined, "", "es", 1])(
    "should fall back to auto for unsupported value %j",
    (value) => {
      expect(execute(value)).toBe("auto");
    },
  );
});
