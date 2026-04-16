import React from "react";
import { Box, Text } from "ink";
import type { PR } from "@shared/schema";
import { FeedbackList, FeedbackPreview } from "./FeedbackList";
import {
  formatStatusLabel,
  getViewportRange,
  middleTruncateText,
  truncateText,
} from "../viewModel";
import { color, glyph, prStatusGlyph, prStatusTone } from "../theme";

type PrDetailPaneProps = {
  pr: PR | null;
  selectedFeedbackIndex: number;
  active: boolean;
  expandedFeedbackIds: Set<string>;
  selectedActionIndex: number;
  selectedActions: string[];
  width?: number;
  height?: number;
};

export function PrDetailPane(props: PrDetailPaneProps) {
  const borderColor = props.active ? color.accent : color.muted;
  const innerWidth = Math.max(24, (props.width ?? 80) - 4);
  const contentHeight = Math.max(4, props.height - 4);

  if (!props.pr) {
    return (
      <Box
        flexDirection="column"
        borderStyle={props.active ? "round" : "single"}
        borderColor={borderColor}
        paddingX={1}
        width={props.width}
        height={props.height}
        flexGrow={1}
      >
        <Box>
          <Text bold color={props.active ? color.accent : undefined}>
            PR Detail
          </Text>
        </Box>
        <Text color={color.muted}>Select a PR.</Text>
      </Box>
    );
  }

  const selectedFeedback = props.pr.feedbackItems[props.selectedFeedbackIndex] ?? null;
  const selectedExpanded = selectedFeedback ? props.expandedFeedbackIds.has(selectedFeedback.id) : false;
  const actionRowCount = selectedExpanded && props.active ? 1 : 0;
  const bodyBudget = Math.max(6, contentHeight - 6 - actionRowCount);
  const listRowCount = Math.max(3, Math.min(8, Math.floor(bodyBudget * 0.45)));
  const previewHeight = Math.max(3, bodyBudget - listRowCount + actionRowCount);
  const viewport = getViewportRange(props.pr.feedbackItems.length, props.selectedFeedbackIndex, listRowCount);
  const visibleFeedbackItems = props.pr.feedbackItems.slice(viewport.start, viewport.end);
  const selectedVisibleIndex = props.selectedFeedbackIndex - viewport.start;
  const repoLabel = middleTruncateText(props.pr.repo, Math.max(18, Math.floor(innerWidth * 0.55)));
  const title = truncateText(props.pr.title, innerWidth);

  return (
    <Box
      flexDirection="column"
      borderStyle={props.active ? "round" : "single"}
      borderColor={borderColor}
      paddingX={1}
      width={props.width}
      height={props.height}
      flexGrow={1}
    >
      <Box>
        <Text bold color={props.active ? color.accent : undefined}>
          PR Detail
        </Text>
      </Box>
      <Box>
        <Text color={color.muted}>{repoLabel}</Text>
        <Text color={color.muted}>{"  "}</Text>
        <Text bold color={color.accent}>#{props.pr.number}</Text>
      </Box>
      <Box>
        <Text bold>{title}</Text>
      </Box>
      <Box>
        <Text color={prStatusTone(props.pr.status)}>
          {prStatusGlyph(props.pr.status)}
          {" "}
          {formatStatusLabel(props.pr.status)}
        </Text>
        <Text color={color.muted}>{`  ${glyph.sep}  `}</Text>
        <Text color={props.pr.watchEnabled ? color.ok : color.warn}>
          {props.pr.watchEnabled ? glyph.dot : glyph.pause}
          {" "}
          {props.pr.watchEnabled ? "watching" : "paused"}
        </Text>
        <Text color={color.muted}>{`  ${glyph.sep}  `}</Text>
        <Text color={color.muted}>feedback </Text>
        <Text bold>{props.pr.feedbackItems.length}</Text>
      </Box>
      <Box>
        <Text color={color.muted}>
          Feedback
          {`  ${visibleFeedbackItems.length}/${props.pr.feedbackItems.length}`}
          {(viewport.hiddenAbove > 0 || viewport.hiddenBelow > 0)
            ? `  ↑${viewport.hiddenAbove} ↓${viewport.hiddenBelow}`
            : ""}
        </Text>
      </Box>
      <FeedbackList
        items={visibleFeedbackItems}
        selectedFeedbackIndex={Math.max(0, selectedVisibleIndex)}
        width={innerWidth}
      />
      <Box>
        <Text color={color.muted}>Selected feedback</Text>
      </Box>
      <FeedbackPreview
        item={selectedFeedback}
        active={props.active}
        expanded={selectedExpanded}
        selectedActionIndex={props.selectedActionIndex}
        selectedActions={props.selectedActions}
        width={innerWidth}
        height={previewHeight}
      />
    </Box>
  );
}
