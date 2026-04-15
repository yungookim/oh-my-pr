import React from "react";
import { Box, Text } from "ink";
import type { InputMode } from "../useSelectionState";

const ACTIONS = ["Sync repositories", "Add repository", "Add PR URL"] as const;

export function RepoManagerPane(props: {
  repos: string[];
  selectedActionIndex: number;
  inputMode: InputMode;
  inputValue: string;
}) {
  return (
    <Box flexDirection="column">
      {ACTIONS.map((action, index) => (
        <Text key={action} color={index === props.selectedActionIndex ? "cyan" : undefined}>
          {index === props.selectedActionIndex ? "› " : "  "}
          {action}
        </Text>
      ))}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Tracked repositories</Text>
        {props.repos.length === 0 ? (
          <Text dimColor>None yet.</Text>
        ) : props.repos.map((repo) => (
          <Text key={repo}>{repo}</Text>
        ))}
      </Box>
      {props.inputMode !== "none" && (
        <Text color="green">
          {props.inputMode === "addRepo" ? "Repo" : "PR URL"}: {props.inputValue || "…"}
        </Text>
      )}
    </Box>
  );
}
