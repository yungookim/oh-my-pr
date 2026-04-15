import React from "react";
import { Box, Text } from "ink";
import type { Config } from "@shared/schema";

export function SettingsPane(props: {
  config: Config | null;
  selectedIndex: number;
}) {
  const rows = [
    `Coding agent: ${props.config?.codingAgent ?? "claude"}`,
    `Auto-resolve conflicts: ${props.config?.autoResolveMergeConflicts ? "on" : "off"}`,
    `Auto-update docs: ${props.config?.autoUpdateDocs ? "on" : "off"}`,
  ];

  return (
    <Box flexDirection="column">
      {rows.map((row, index) => (
        <Text key={row} color={index === props.selectedIndex ? "cyan" : undefined}>
          {index === props.selectedIndex ? "› " : "  "}
          {row}
        </Text>
      ))}
      <Text dimColor>Enter toggles the selected setting.</Text>
    </Box>
  );
}
