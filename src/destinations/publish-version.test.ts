import { describe, expect, it, vi } from "vitest";

import type { Destination } from "@/destinations/destination.js";
import { execute } from "@/destinations/publish-version.js";

const destination = (
  publishRelease = vi.fn(async () => ({ pageId: "page-123" })),
): Destination => ({
  publishPR: vi.fn(async () => ({ pageId: "" })),
  publishPush: vi.fn(async () => ({ pageId: "" })),
  publishRelease,
});

const versionSelect = (row: Record<string, unknown> | undefined) => () => ({
  from: vi.fn(() => ({
    where: vi.fn(() => ({
      limit: vi.fn(async () => (row === undefined ? [] : [row])),
    })),
  })),
});

const releasedVersion = {
  id: "40000000-0000-4000-8000-000000000001",
  displayVersion: "1.3.4",
  normalizedVersion: "1.3.4+6",
  buildVersion: "6",
  title: "Responsive quick actions",
  changelog: "Quick actions are easier to tap.",
  sections: [{ label: "Improvements", items: ["Larger tap targets"] }],
  status: "released",
  sourceUrl: null,
  sourceReleaseId: "30000000-0000-4000-8000-000000000001",
  beforeSha: "before",
  headSha: "after",
};

describe("destinations/publish-version", () => {
  it("should publish a canonical version and remember the Notion page", async () => {
    const publishRelease = vi.fn(async () => ({ pageId: "page-123" }));
    const select = vi
      .fn()
      .mockImplementationOnce(versionSelect(releasedVersion))
      .mockImplementationOnce(
        versionSelect({
          id: releasedVersion.sourceReleaseId,
          versionKey: "1.3.4+6",
          previousVersionKey: "1.3.3+5",
          branch: "main",
          prNumbers: [16],
        }),
      );
    const updateWhere = vi.fn(async () => undefined);
    const update = vi.fn(() => ({
      set: vi.fn(() => ({ where: updateWhere })),
    }));

    const result = await execute({
      db: { select, update } as never,
      workspaceId: "10000000-0000-4000-8000-000000000001",
      repoFullName: "AntonyLajes/ride-pack",
      repoDefaultBranch: "main",
      versionId: releasedVersion.id,
      destination: destination(publishRelease),
    });

    expect(result).toMatchObject({
      kind: "published",
      pageId: "page-123",
      pageUrl: "https://www.notion.so/page123",
    });
    expect(publishRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Responsive quick actions",
        newVersionKey: "1.3.4+6",
        previousVersionKey: "1.3.3+5",
        prNumbers: [16],
        compareUrl:
          "https://github.com/AntonyLajes/ride-pack/compare/before...after",
      }),
    );
    expect(update).toHaveBeenCalledOnce();
  });

  it("should publish a tag-backed version without a legacy release row", async () => {
    const publishRelease = vi.fn(async () => ({ pageId: "tag-page" }));
    const select = vi.fn().mockImplementationOnce(
      versionSelect({
        ...releasedVersion,
        sourceReleaseId: null,
        sourceUrl:
          "https://github.com/AntonyLajes/ride-pack/releases/tag/v1.3.4",
      }),
    );

    const result = await execute({
      db: { select, update: vi.fn() } as never,
      workspaceId: "10000000-0000-4000-8000-000000000001",
      repoFullName: "AntonyLajes/ride-pack",
      repoDefaultBranch: "main",
      versionId: releasedVersion.id,
      destination: destination(publishRelease),
    });

    expect(result.kind).toBe("published");
    expect(publishRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        newVersionKey: "1.3.4+6",
        compareUrl:
          "https://github.com/AntonyLajes/ride-pack/releases/tag/v1.3.4",
      }),
    );
  });

  it.each([
    [undefined, "not_found"],
    [{ ...releasedVersion, status: "in_development" }, "not_released"],
    [{ ...releasedVersion, changelog: null }, "summary_not_ready"],
  ] as const)(
    "should return %s as %s without publishing",
    async (row, kind) => {
      const publishRelease = vi.fn(async () => ({ pageId: "unexpected" }));
      const result = await execute({
        db: {
          select: vi.fn().mockImplementationOnce(versionSelect(row)),
        } as never,
        workspaceId: "10000000-0000-4000-8000-000000000001",
        repoFullName: "AntonyLajes/ride-pack",
        repoDefaultBranch: "main",
        versionId: releasedVersion.id,
        destination: destination(publishRelease),
      });

      expect(result.kind).toBe(kind);
      expect(publishRelease).not.toHaveBeenCalled();
    },
  );

  it("should reject an empty destination page id", async () => {
    await expect(
      execute({
        db: {
          select: vi
            .fn()
            .mockImplementationOnce(
              versionSelect({ ...releasedVersion, sourceReleaseId: null }),
            ),
        } as never,
        workspaceId: "10000000-0000-4000-8000-000000000001",
        repoFullName: "AntonyLajes/ride-pack",
        repoDefaultBranch: "main",
        versionId: releasedVersion.id,
        destination: destination(vi.fn(async () => ({ pageId: "" }))),
      }),
    ).rejects.toThrow(/empty page id/i);
  });
});
