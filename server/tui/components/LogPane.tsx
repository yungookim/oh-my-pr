import React from "react";
import { Box, Text } from "ink";
import type { LogEntry } from "@shared/schema";
import { color } from "../theme";

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

export function LogPane(props: { logs: LogEntry[] }) {
  const rows = props.logs.slice(-10);

  if (rows.length === 0) {
    return <Text color={color.muted}>No log entries.</Text>;
  }

  return (
    <Box flexDirection="column">
      {rows.map((log) => {
        const tone = LEVEL_TONE[log.level.toLowerCase()] ?? color.muted;
        return (
          <Text key={log.id}>
            <Text color={color.muted}>{formatTime(log.timestamp)} </Text>
            <Text color={tone} bold>{log.level.toUpperCase()}</Text>
            {log.phase && <Text color={color.muted}> {log.phase}</Text>}
            <Text> {log.message}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
