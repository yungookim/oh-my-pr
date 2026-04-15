import React from "react";
import { Box, Text } from "ink";
import type { Config, LogEntry, PRQuestion } from "@shared/schema";
import type { ContextMode, InputMode } from "../useSelectionState";
import { LogPane } from "./LogPane";
import { AskPane } from "./AskPane";
import { RepoManagerPane } from "./RepoManagerPane";
import { SettingsPane } from "./SettingsPane";

export function ContextPane(props: {
  mode: ContextMode;
  active: boolean;
  width?: number;
  logs: LogEntry[];
  questions: PRQuestion[];
  repos: string[];
  config: Config | null;
  selectedContextIndex: number;
  inputMode: InputMode;
  inputValue: string;
}) {
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} width={props.width}>
      <Text bold color={props.active ? "cyan" : undefined}>Context</Text>
      <Text dimColor>logs | ask | repos | settings</Text>
      <Box marginTop={1} flexDirection="column">
        {props.mode === "logs" && <LogPane logs={props.logs} />}
        {props.mode === "ask" && (
          <AskPane
            questions={props.questions}
            inputMode={props.inputMode === "ask"}
            inputValue={props.inputValue}
            width={props.width ?? 40}
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
