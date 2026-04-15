import React from "react";
import { Box, Text } from "ink";
import type { FeedbackItem } from "@shared/schema";
import { getFeedbackActions, formatFeedbackStatusLabel, wrapText } from "../viewModel";
import { FeedbackActions } from "./FeedbackActions";

export function FeedbackList(props: {
  items: FeedbackItem[];
  selectedFeedbackIndex: number;
  active: boolean;
  expandedFeedbackIds: Set<string>;
  selectedActionIndex: number;
  selectedActions: string[];
  width: number;
}) {
  if (props.items.length === 0) {
    return <Text dimColor>No feedback items yet.</Text>;
  }

  return (
    <Box flexDirection="column">
      {props.items.map((item, index) => {
        const selected = index === props.selectedFeedbackIndex;
        const expanded = props.expandedFeedbackIds.has(item.id);
        const actions = selected && expanded ? props.selectedActions : getFeedbackActions(item);
        const wrappedBody = wrapText(item.body, Math.max(20, props.width - 8));

        return (
          <Box key={item.id} flexDirection="column" marginBottom={1}>
            <Text color={selected ? "cyan" : undefined}>
              {selected ? "› " : "  "}
              [{formatFeedbackStatusLabel(item.status)}] {item.author} {item.file ? `· ${item.file}${item.line ? `:${item.line}` : ""}` : ""}
            </Text>
            {expanded && (
              <Box flexDirection="column" marginLeft={2}>
                {wrappedBody.map((line, lineIndex) => (
                  <Text key={`${item.id}-${lineIndex}`}>{line}</Text>
                ))}
                {selected && props.active && (
                  <FeedbackActions actions={actions} selectedActionIndex={Math.min(props.selectedActionIndex, actions.length - 1)} />
                )}
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
