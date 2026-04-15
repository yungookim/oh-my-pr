import React from "react";
import { Box, Text } from "ink";
import type { PR } from "@shared/schema";
import { FeedbackList } from "./FeedbackList";
import { formatStatusLabel } from "../viewModel";

export function PrDetailPane(props: {
  pr: PR | null;
  selectedFeedbackIndex: number;
  active: boolean;
  expandedFeedbackIds: Set<string>;
  selectedActionIndex: number;
  selectedActions: string[];
  width?: number;
}) {
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} width={props.width} flexGrow={1}>
      <Text bold color={props.active ? "cyan" : undefined}>PR Detail</Text>
      {!props.pr ? (
        <Text dimColor>Select a PR.</Text>
      ) : (
        <>
          <Text>{props.pr.repo} #{props.pr.number}</Text>
          <Text bold>{props.pr.title}</Text>
          <Text dimColor>
            status={formatStatusLabel(props.pr.status)}  watch={props.pr.watchEnabled ? "on" : "paused"}  feedback={props.pr.feedbackItems.length}
          </Text>
          <Box marginTop={1}>
            <FeedbackList
              items={props.pr.feedbackItems}
              selectedFeedbackIndex={props.selectedFeedbackIndex}
              active={props.active}
              expandedFeedbackIds={props.expandedFeedbackIds}
              selectedActionIndex={props.selectedActionIndex}
              selectedActions={props.selectedActions}
              width={props.width ?? 80}
            />
          </Box>
        </>
      )}
    </Box>
  );
}
