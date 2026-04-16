import React from "react";
import { Box, Text } from "ink";
import { getDisplayWidth, getFooterHints } from "../viewModel";
import type { ContextMode } from "../useSelectionState";
import { color, glyph } from "../theme";
import { truncateText } from "../viewModel";

type FooterProps = {
  contextMode: ContextMode;
  statusMessage: string | null;
  errorMessage: string | null;
  width?: number;
};

export function Footer(props: FooterProps) {
  const hasError = Boolean(props.errorMessage);
  const statusTone = hasError ? color.err : props.statusMessage ? color.ok : color.muted;
  const statusText = props.errorMessage ?? props.statusMessage ?? "Ready";
  const hints = getFooterHints();
  const innerWidth = Math.max(24, (props.width ?? 100) - 4);
  const statusLabel = `${glyph.dot} ${statusText}`;
  const statusWidth = Math.min(Math.max(10, getDisplayWidth(statusLabel)), Math.max(10, Math.floor(innerWidth * 0.28)));
  const hintsWidth = Math.max(8, innerWidth - statusWidth - 3);
  const hintLine = truncateText(
    hints.map((hint) => `${hint.key} ${hint.label}`).join(" | "),
    hintsWidth,
  );

  return (
    <Box
      borderStyle="round"
      borderColor={color.muted}
      paddingX={1}
      width={props.width}
    >
      <Text color={statusTone} bold={hasError} wrap="truncate-end">
        {truncateText(statusLabel, statusWidth)}
      </Text>
      <Text color={color.muted}> | </Text>
      <Text color={color.muted} wrap="truncate-end">{hintLine}</Text>
    </Box>
  );
}
