import React from "react";
import { Box, Text } from "ink";
import type { Config } from "@shared/schema";
import type { TuiRuntimeSnapshot } from "../types";

export function Header(props: {
  runtime: TuiRuntimeSnapshot | null;
  config: Config | null;
  repoCount: number;
  prCount: number;
  activePane: string;
  contextMode: string;
}) {
  return (
    <Box justifyContent="space-between" borderStyle="single" paddingX={1}>
      <Text bold>oh-my-pr tui</Text>
      <Text>
        agent={props.config?.codingAgent ?? "claude"}  repos={props.repoCount}  prs={props.prCount}  activeRuns={props.runtime?.activeRuns ?? 0}  pane={props.activePane}  context={props.contextMode}
      </Text>
    </Box>
  );
}
