import React from "react";
import { Box, Text } from "ink";
import type { LogEntry } from "@shared/schema";

export function LogPane(props: { logs: LogEntry[] }) {
  const rows = props.logs.slice(-10);

  if (rows.length === 0) {
    return <Text dimColor>No log entries.</Text>;
  }

  return (
    <Box flexDirection="column">
      {rows.map((log) => (
        <Text key={log.id}>
          {new Date(log.timestamp).toLocaleTimeString("en-US", { hour12: false })} [{log.level}] {log.phase ? `${log.phase} ` : ""}{log.message}
        </Text>
      ))}
    </Box>
  );
}
