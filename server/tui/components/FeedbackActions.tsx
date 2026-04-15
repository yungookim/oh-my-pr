import React from "react";
import { Box, Text } from "ink";

export function FeedbackActions(props: {
  actions: string[];
  selectedActionIndex: number;
}) {
  return (
    <Box marginTop={1}>
      {props.actions.map((action, index) => (
        <Text key={action} color={index === props.selectedActionIndex ? "green" : undefined}>
          {index === props.selectedActionIndex ? "[*] " : "[ ] "}
          {action}
          {index < props.actions.length - 1 ? "  " : ""}
        </Text>
      ))}
    </Box>
  );
}
