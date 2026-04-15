import React from "react";
import { Box, Text } from "ink";
import { formatFooterHints } from "../viewModel";
import type { ContextMode } from "../useSelectionState";

export function Footer(props: {
  contextMode: ContextMode;
  statusMessage: string | null;
  errorMessage: string | null;
}) {
  return (
    <Box justifyContent="space-between" borderStyle="single" paddingX={1}>
      <Text color={props.errorMessage ? "red" : "green"}>
        {props.errorMessage ?? props.statusMessage ?? "Ready"}
      </Text>
      <Text dimColor>{formatFooterHints(props.contextMode)}</Text>
    </Box>
  );
}
