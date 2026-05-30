import type { PushSummary } from "@/destinations/destination.js";

interface RichText {
  type: "text";
  text: {
    content: string;
  };
}

interface HeadingBlock {
  object: "block";
  type: "heading_2";
  heading_2: {
    rich_text: RichText[];
  };
}

interface ParagraphBlock {
  object: "block";
  type: "paragraph";
  paragraph: {
    rich_text: RichText[];
  };
}

export type NotionBlock = HeadingBlock | ParagraphBlock;

const text = (content: string): RichText => ({
  type: "text",
  text: { content },
});

export const execute = (summary: PushSummary): NotionBlock[] => {
  return [
    {
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: [text("User-facing")],
      },
    },
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [text(summary.summaryUserFacing)],
      },
    },
    {
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: [text("Technical")],
      },
    },
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [text(summary.summaryTechnical)],
      },
    },
  ];
};
