import React from "react";
import { Box, Text } from "ink";
import type { Config, LogEntry, PRQuestion } from "@shared/schema";
import type { ContextMode, InputMode } from "../useSelectionState";
import { LogPane } from "./LogPane";
import { AskPane } from "./AskPane";
import { RepoManagerPane } from "./RepoManagerPane";
import { SettingsPane } from "./SettingsPane";
import { color } from "../theme";
import { truncateText } from "../viewModel";

type ContextPaneProps = {
  mode: ContextMode;
  active: boolean;
  width: number;
  height: number;
  logs: LogEntry[];
  questions: PRQuestion[];
  repos: string[];
  config: Config | null;
  selectedContextIndex: number;
  inputMode: InputMode;
  inputValue: string;
};

const TABS: Array<{ key: ContextMode; label: string; hint: string }> = [
  { key: "logs", label: "logs", hint: "l" },
  { key: "ask", label: "ask", hint: "a" },
  { key: "repos", label: "repos", hint: "o" },
  { key: "settings", label: "settings", hint: "s" },
];

function formatTabLabel(tab: { key: ContextMode; label: string; hint: string }, activeMode: ContextMode): string {
  if (tab.key === activeMode) {
    return `[${tab.label}]`;
  }

  return `${tab.label}[${tab.hint}]`;
}

function TabStrip(props: { mode: ContextMode; active: boolean; width: number }) {
  const tabLine = truncateText(
    TABS.map((tab) => formatTabLabel(tab, props.mode)).join("  "),
    props.width,
  );

  return (
    <Text color={props.active ? color.accent : color.muted} bold={props.active} wrap="truncate-end">
      {tabLine}
    </Text>
  );
}

export function ContextPane(props: ContextPaneProps) {
  const borderColor = props.active ? color.accent : color.muted;
  const innerWidth = Math.max(20, props.width - 4);
  const innerHeight = Math.max(2, props.height - 5);

  return (
    <Box
      flexDirection="column"
      borderStyle={props.active ? "round" : "single"}
      borderColor={borderColor}
      paddingX={1}
      width={props.width}
      height={props.height}
    >
      <Box justifyContent="space-between">
        <Text bold color={props.active ? color.accent : undefined}>
          Context
        </Text>
      </Box>
      <TabStrip mode={props.mode} active={props.active} width={innerWidth} />
      <Box marginTop={1} flexDirection="column">
        {props.mode === "logs" && <LogPane logs={props.logs} width={innerWidth} height={innerHeight} />}
        {props.mode === "ask" && (
          <AskPane
            questions={props.questions}
            inputMode={props.inputMode === "ask"}
            inputValue={props.inputValue}
            width={props.width}
          />
        )}
        {props.mode === "repos" && (
          <RepoManagerPane
            repos={props.repos}
            selectedActionIndex={props.selectedContextIndex}
            inputMode={props.inputMode}
            inputValue={props.inputValue}
          />
        )}
        {props.mode === "settings" && (
          <SettingsPane config={props.config} selectedIndex={props.selectedContextIndex} />
        )}
      </Box>
    </Box>
  );
}
