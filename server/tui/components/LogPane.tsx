import React from "react";
import { Box, Text } from "ink";
import type { LogEntry } from "@shared/schema";
import { color } from "../theme";
import { middleTruncateText, truncateText } from "../viewModel";

const LEVEL_TONE: Record<string, string> = {
  error: color.err,
  warn: color.warn,
  warning: color.warn,
  info: color.accent,
  debug: color.muted,
};

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString("en-US", { hour12: false });
}

export function LogPane(props: { logs: LogEntry[]; width: number; height: number }) {
  const rowCount = Math.max(3, props.height - 2);
  const rows = props.logs.slice(-rowCount);
  const hiddenCount = Math.max(0, props.logs.length - rows.length);

  if (rows.length === 0) {
    return <Text color={color.muted}>No log entries.</Text>;
  }

  return (
    <Box flexDirection="column">
      {hiddenCount > 0 && (
        <Text color={color.muted}>{`↑ ${hiddenCount} earlier log${hiddenCount === 1 ? "" : "s"}`}</Text>
      )}
      {rows.map((log) => {
        const tone = LEVEL_TONE[log.level.toLowerCase()] ?? color.muted;
        const phase = log.phase ? middleTruncateText(log.phase, Math.max(8, Math.floor(props.width * 0.2))) : "";
        const prefix = `${formatTime(log.timestamp)} ${log.level.toUpperCase()}${phase ? ` ${phase}` : ""} `;
        const message = truncateText(log.message, Math.max(12, props.width - prefix.length));
        return (
        <Text key={log.id} wrap="truncate-end">
          <Text color={color.muted}>{formatTime(log.timestamp)} </Text>
          <Text color={tone} bold>{log.level.toUpperCase()}</Text>
          {phase && <Text color={color.muted}> {phase}</Text>}
            <Text> {message}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
