import React from "react";
import { Box, Text } from "ink";
import type { PR } from "@shared/schema";
import { formatPrRow } from "../viewModel";

export function PrListPane(props: {
  prs: PR[];
  selectedPrIndex: number;
  active: boolean;
  width?: number;
}) {
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} width={props.width}>
      <Text bold color={props.active ? "cyan" : undefined}>Pull Requests</Text>
      {props.prs.length === 0 ? (
        <Text dimColor>No tracked PRs.</Text>
      ) : props.prs.map((pr, index) => {
        const selected = index === props.selectedPrIndex;

        return (
          <Text key={pr.id} color={selected ? "cyan" : undefined}>
            {selected ? "› " : "  "}
            {formatPrRow(pr)}
          </Text>
        );
      })}
    </Box>
  );
}
