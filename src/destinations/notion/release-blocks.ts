import type { ReleaseNotesSummary } from "@/destinations/destination.js";

type RichText = { type: "text"; text: { content: string } };
type NotionBlock =
  | {
      object: "block";
      type: "heading_2";
      heading_2: { rich_text: RichText[] };
    }
  | {
      object: "block";
      type: "paragraph";
      paragraph: { rich_text: RichText[] };
    }
  | {
      object: "block";
      type: "bulleted_list_item";
      bulleted_list_item: { rich_text: RichText[] };
    };

const text = (content: string): RichText => ({
  type: "text",
  text: { content },
});

const paragraph = (s: string): NotionBlock => ({
  object: "block",
  type: "paragraph",
  paragraph: { rich_text: [text(s)] },
});

const heading2 = (s: string): NotionBlock => ({
  object: "block",
  type: "heading_2",
  heading_2: { rich_text: [text(s)] },
});

const bullet = (s: string): NotionBlock => ({
  object: "block",
  type: "bulleted_list_item",
  bulleted_list_item: { rich_text: [text(s)] },
});

export const execute = (summary: ReleaseNotesSummary): NotionBlock[] => {
  const blocks: NotionBlock[] = [
    heading2("User-facing"),
    paragraph(summary.userFacing),
    heading2("Technical"),
    paragraph(summary.technical),
  ];

  for (const section of summary.sections) {
    if (section.items.length === 0) {
      continue;
    }
    blocks.push(heading2(section.label));
    for (const item of section.items) {
      blocks.push(bullet(item));
    }
  }

  return blocks;
};
