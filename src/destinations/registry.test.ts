import { describe, expect, it } from "vitest";

import {
  destinationTypeSchema,
  getDestination,
  isImplementedDestination,
  UnsupportedDestinationError,
} from "@/destinations/registry.js";

describe("destinations/registry", () => {
  it("accepts known destination types in the schema", () => {
    expect(destinationTypeSchema.safeParse("notion").success).toBe(true);
    expect(destinationTypeSchema.safeParse("slack").success).toBe(true);
    expect(destinationTypeSchema.safeParse("whatsapp").success).toBe(true);
    expect(destinationTypeSchema.safeParse("email").success).toBe(false);
  });

  it("marks only notion as implemented today", () => {
    expect(isImplementedDestination("notion")).toBe(true);
    expect(isImplementedDestination("slack")).toBe(false);
    expect(isImplementedDestination("whatsapp")).toBe(false);
  });

  it("returns a Destination for notion", () => {
    const destination = getDestination("notion", {
      token: "secret_xyz",
      config: { prDatabaseId: "db-1" },
    });
    expect(typeof destination.publishPR).toBe("function");
    expect(typeof destination.publishRelease).toBe("function");
    expect(typeof destination.publishPush).toBe("function");
  });

  it("throws UnsupportedDestinationError for types without an implementation", () => {
    expect(() => getDestination("slack", { token: "t", config: null })).toThrow(
      UnsupportedDestinationError,
    );
    expect(() => getDestination("whatsapp", { token: "t", config: null })).toThrow(
      /unsupported_destination/,
    );
  });
});
