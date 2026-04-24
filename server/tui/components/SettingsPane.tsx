import React from "react";
import { Box, Text } from "ink";
import type { Config } from "@shared/schema";
import { color, glyph } from "../theme";
import type { InputMode } from "../useSelectionState";

type ToggleField =
  | "autoResolveMergeConflicts"
  | "autoUpdateDocs"
  | "autoHealCI"
  | "autoCreateReleases"
  | "includeRepositoryLinksInGitHubComments";

export type SettingRow =
  | { kind: "codingAgent"; label: string; value: string }
  | { kind: "toggle"; label: string; field: ToggleField; value: boolean }
  | { kind: "addGithubToken"; label: string; value: string }
  | { kind: "tokenInfo"; label: string; token: string; index: number }
  | { kind: "tokenMoveUp"; label: string; token: string; index: number; disabled: boolean }
  | { kind: "tokenMoveDown"; label: string; token: string; index: number; disabled: boolean }
  | { kind: "tokenRemove"; label: string; token: string; index: number };

export function getGithubTokens(config: Config | null): string[] {
  return config?.githubTokens ?? (config?.githubToken ? [config.githubToken] : []);
}

function formatTokenForDisplay(token: string): string {
  if (!token) {
    return "";
  }

  if (token.startsWith("***")) {
    return token;
  }

  return `***${token.slice(-4)}`;
}

function maskInput(value: string): string {
  if (!value) {
    return "…";
  }

  return "*".repeat(Math.min(value.length, 24));
}

function getRowDisplay(row: SettingRow): { tone: string; value: string } {
  switch (row.kind) {
    case "toggle":
      return { tone: row.value ? color.ok : color.muted, value: "" };
    case "tokenInfo":
      return { tone: color.accent, value: `${formatTokenForDisplay(row.token)} p${row.index + 1}` };
    case "tokenMoveUp":
    case "tokenMoveDown":
      return {
        tone: row.disabled ? color.muted : color.accent,
        value: row.disabled ? "unavailable" : formatTokenForDisplay(row.token),
      };
    case "tokenRemove":
      return { tone: color.accent, value: formatTokenForDisplay(row.token) };
    case "codingAgent":
    case "addGithubToken":
      return { tone: color.accent, value: row.value };
  }
}

function getRowKey(row: SettingRow): string {
  switch (row.kind) {
    case "toggle":
      return `${row.kind}-${row.field}`;
    case "tokenInfo":
    case "tokenMoveUp":
    case "tokenMoveDown":
    case "tokenRemove":
      return `${row.kind}-${row.index}`;
    default:
      return row.kind;
  }
}

export function getSettingsActionRows(config: Config | null): SettingRow[] {
  const tokens = getGithubTokens(config);
  return [
    { kind: "codingAgent", label: "Coding agent", value: config?.codingAgent ?? "claude" },
    {
      kind: "toggle",
      label: "Merge conflicts",
      field: "autoResolveMergeConflicts",
      value: config?.autoResolveMergeConflicts ?? true,
    },
    {
      kind: "toggle",
      label: "Docs updates",
      field: "autoUpdateDocs",
      value: config?.autoUpdateDocs ?? true,
    },
    {
      kind: "toggle",
      label: "CI healing",
      field: "autoHealCI",
      value: Boolean(config?.autoHealCI),
    },
    {
      kind: "toggle",
      label: "Auto release",
      field: "autoCreateReleases",
      value: config?.autoCreateReleases ?? true,
    },
    {
      kind: "toggle",
      label: "Repo links",
      field: "includeRepositoryLinksInGitHubComments",
      value: config?.includeRepositoryLinksInGitHubComments ?? true,
    },
    { kind: "addGithubToken", label: "Add GitHub token", value: "new" },
    ...tokens.flatMap((token, index): SettingRow[] => [
      { kind: "tokenInfo", label: `Token ${index + 1}`, token, index },
      { kind: "tokenMoveUp", label: `Move up ${index + 1}`, token, index, disabled: index === 0 },
      { kind: "tokenMoveDown", label: `Move down ${index + 1}`, token, index, disabled: index === tokens.length - 1 },
      { kind: "tokenRemove", label: `Remove ${index + 1}`, token, index },
    ]),
  ];
}

export function SettingsPane(props: {
  config: Config | null;
  selectedIndex: number;
  inputMode: InputMode;
  inputValue: string;
}) {
  const rows = getSettingsActionRows(props.config);

  return (
    <Box flexDirection="column">
      <Text color={color.muted}>GitHub tokens</Text>
      {rows.map((row, index) => {
        const selected = index === props.selectedIndex;
        const isToggle = row.kind === "toggle";
        const { tone, value } = getRowDisplay(row);

        return (
          <Box key={getRowKey(row)}>
            <Text color={selected ? color.accent : color.muted}>
              {selected ? `${glyph.focus} ` : "  "}
            </Text>
            <Text color={selected ? color.accent : undefined}>{row.label}</Text>
            <Text color={color.muted}>{"  "}</Text>
            {isToggle ? (
              <Text color={tone} bold>
                {row.value ? `${glyph.dot} on` : `${glyph.ring} off`}
              </Text>
            ) : (
              <Text color={tone} bold>
                {String(value)}
              </Text>
            )}
          </Box>
        );
      })}
      {props.inputMode === "addGithubToken" && (
        <Box marginTop={1}>
          <Text color={color.ok} bold>GitHub token</Text>
          <Text color={color.muted}>{": "}</Text>
          <Text>{maskInput(props.inputValue)}</Text>
          <Text color={color.accent}>▌</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={color.muted}>Enter edits the selected setting or token action.</Text>
      </Box>
    </Box>
  );
}
