import React from "react";
import { Box, Text } from "ink";
import type { FeedbackItem } from "@shared/schema";
import {
  formatFeedbackStatusLabel,
  middleTruncateText,
  truncateText,
  wrapText,
} from "../viewModel";
import { FeedbackActions } from "./FeedbackActions";
import { color, feedbackGlyph, feedbackTone, glyph } from "../theme";

type FeedbackListProps = {
  items: FeedbackItem[];
  selectedFeedbackIndex: number;
  width: number;
};

type FeedbackPreviewProps = {
  item: FeedbackItem | null;
  active: boolean;
  expanded: boolean;
  selectedActionIndex: number;
  selectedActions: string[];
  width: number;
  height: number;
};

function summarizeBody(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

export function FeedbackList(props: FeedbackListProps) {
  if (props.items.length === 0) {
    return <Text color={color.muted}>No feedback items yet.</Text>;
  }

  return (
    <Box flexDirection="column">
      {props.items.map((item, index) => {
        const selected = index === props.selectedFeedbackIndex;
        const tone = feedbackTone(item.status);
        const statusLabel = formatFeedbackStatusLabel(item.status);
        const availableMetadataWidth = Math.max(12, props.width - 2);
        const authorBudget = Math.max(8, Math.min(18, Math.floor(availableMetadataWidth * 0.24)));
        const author = truncateText(item.author, authorBudget);
        const location = item.file ? `${item.file}${item.line ? `:${item.line}` : ""}` : "";
        const locationText = location
          ? middleTruncateText(location, Math.max(10, Math.min(24, Math.floor(availableMetadataWidth * 0.34))))
          : "";
        const summary = truncateText(
          [
            `${feedbackGlyph(item.status)} ${statusLabel}`,
            locationText,
            author,
            summarizeBody(item.body),
          ].filter(Boolean).join(" │ "),
          props.width - 2,
        );

        return (
          <Text key={item.id} color={selected ? color.accent : tone}>
            {selected ? `${glyph.focus} ` : "  "}
            {summary}
          </Text>
        );
      })}
    </Box>
  );
}

export function FeedbackPreview(props: FeedbackPreviewProps) {
  if (!props.item) {
    return <Text color={color.muted}>Select a feedback item.</Text>;
  }

  const item = props.item;
  const tone = feedbackTone(item.status);
  const statusLabel = formatFeedbackStatusLabel(item.status);
  const author = truncateText(item.author, Math.max(10, Math.floor(props.width * 0.22)));
  const location = item.file ? `${item.file}${item.line ? `:${item.line}` : ""}` : "";
  const metadataLocation = location
    ? middleTruncateText(location, Math.max(16, Math.floor(props.width * 0.45)))
    : "";
  const metadata = truncateText(
    [
      `${feedbackGlyph(item.status)} ${statusLabel}`,
      metadataLocation,
      author,
    ].filter(Boolean).join(` ${glyph.sep} `),
    props.width,
  );
  const actionRowCount = props.expanded && props.active ? 1 : 0;
  const wrappedBody = wrapText(item.body, Math.max(16, props.width));
  let bodyLineBudget = Math.max(1, props.height - 1 - actionRowCount);
  let visibleBodyLines = wrappedBody.slice(0, bodyLineBudget);
  let hiddenLineCount = wrappedBody.length - visibleBodyLines.length;

  if (hiddenLineCount > 0 && props.height - 2 - actionRowCount >= 1) {
    bodyLineBudget = Math.max(1, props.height - 2 - actionRowCount);
    visibleBodyLines = wrappedBody.slice(0, bodyLineBudget);
    hiddenLineCount = wrappedBody.length - visibleBodyLines.length;
  }

  return (
    <Box flexDirection="column">
      <Text color={tone}>{metadata}</Text>
      {visibleBodyLines.map((line, lineIndex) => (
        <Text key={`${item.id}-${lineIndex}`} color={color.muted}>
          {line}
        </Text>
      ))}
      {hiddenLineCount > 0 && (
        <Text color={color.muted}>{`↓ ${hiddenLineCount} more line${hiddenLineCount === 1 ? "" : "s"}`}</Text>
      )}
      {props.expanded && props.active && (
        <FeedbackActions
          actions={props.selectedActions}
          selectedActionIndex={Math.min(props.selectedActionIndex, props.selectedActions.length - 1)}
        />
      )}
    </Box>
  );
}
