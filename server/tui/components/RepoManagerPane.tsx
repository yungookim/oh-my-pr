import React from "react";
import { Box, Text } from "ink";
import type { WatchedRepo } from "@shared/schema";
import type { InputMode } from "../useSelectionState";
import { color, glyph } from "../theme";

export type RepoActionRow =
  | { kind: "sync"; label: string }
  | { kind: "addRepo"; label: string }
  | { kind: "addPr"; label: string }
  | { kind: "scope"; repo: WatchedRepo }
  | { kind: "release"; repo: WatchedRepo };

export function getRepoActionRows(repoSettings: WatchedRepo[]): RepoActionRow[] {
  return [
    { kind: "sync", label: "Sync repositories" },
    { kind: "addRepo", label: "Add repository" },
    { kind: "addPr", label: "Add PR URL" },
    ...repoSettings.flatMap((repo): RepoActionRow[] => [
      { kind: "scope", repo },
      { kind: "release", repo },
    ]),
  ];
}

function RepoActionLabel(props: { row: RepoActionRow }) {
  const { row } = props;
  if (row.kind === "scope") {
    return (
      <>
        <Text>{row.repo.repo}</Text>
        <Text color={color.muted}>  Track automatically  </Text>
        <Text color={color.accent} bold>
          {row.repo.ownPrsOnly ? "My PRs only" : "My PRs + teammates"}
        </Text>
      </>
    );
  }

  if (row.kind === "release") {
    return (
      <>
        <Text>{row.repo.repo}</Text>
        <Text color={color.muted}>  Auto-release  </Text>
        <Text color={row.repo.autoCreateReleases ? color.ok : color.muted} bold>
          {row.repo.autoCreateReleases ? `${glyph.dot} on` : `${glyph.ring} off`}
        </Text>
      </>
    );
  }

  return <Text>{row.label}</Text>;
}

function getRowKey(row: RepoActionRow): string {
  if (row.kind === "scope" || row.kind === "release") {
    return `${row.kind}-${row.repo.repo}`;
  }

  return row.kind;
}

export function RepoManagerPane(props: {
  repos: string[];
  repoSettings: WatchedRepo[];
  selectedActionIndex: number;
  inputMode: InputMode;
  inputValue: string;
}) {
  const rows = getRepoActionRows(props.repoSettings);

  return (
    <Box flexDirection="column">
      {rows.map((row, index) => {
        const selected = index === props.selectedActionIndex;
        return (
          <Box key={getRowKey(row)}>
            <Text color={selected ? color.accent : color.muted}>
              {selected ? `${glyph.focus} ` : "  "}
            </Text>
            <Text color={selected ? color.accent : undefined} bold={selected}>
              <RepoActionLabel row={row} />
            </Text>
          </Box>
        );
      })}
      <Box flexDirection="column" marginTop={1}>
        <Text color={color.muted}>Tracked repositories</Text>
        {props.repos.length === 0 ? (
          <Text color={color.muted}>  None yet.</Text>
        ) : (
          props.repos.map((repo) => (
            <Box key={repo}>
              <Text color={color.muted}>  {glyph.dot} </Text>
              <Text>{repo}</Text>
            </Box>
          ))
        )}
      </Box>
      {props.inputMode !== "none" && (
        <Box marginTop={1}>
          <Text color={color.ok} bold>
            {props.inputMode === "addRepo" ? "Repo" : "PR URL"}
          </Text>
          <Text color={color.muted}>{": "}</Text>
          <Text>{props.inputValue || "…"}</Text>
          <Text color={color.accent}>▌</Text>
        </Box>
      )}
    </Box>
  );
}
