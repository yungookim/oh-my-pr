import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme";

type OnboardingScreenProps = {
  value: string;
  errorMessage: string | null;
  submitting?: boolean;
};

export function OnboardingScreen(props: OnboardingScreenProps) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color.accent} paddingX={2} paddingY={1}>
      <Box marginBottom={1}>
        <Text color={color.accent} bold>{glyph.focus} </Text>
        <Text bold>First-time setup</Text>
      </Box>

      <Text>oh-my-pr needs one repository to start watching pull requests.</Text>
      <Text color={color.muted}>Enter a repository slug in the form </Text>
      <Text color={color.accent} bold>owner/repo</Text>
      <Text color={color.muted}>.</Text>

      <Box marginTop={1}>
        <Text color={color.ok} bold>Repository</Text>
        <Text color={color.muted}>{": "}</Text>
        <Text>{props.value || "…"}</Text>
        <Text color={color.accent}>▌</Text>
      </Box>

      <Text color={color.muted}>Example: acme/widgets</Text>

      {props.submitting && (
        <Box marginTop={1}>
          <Text color={color.info}>{glyph.running} </Text>
          <Text color={color.info}>Adding repository…</Text>
        </Box>
      )}

      {props.errorMessage && (
        <Box marginTop={1}>
          <Text color={color.err} bold>{glyph.cross} </Text>
          <Text color={color.err}>{props.errorMessage}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={color.accent} inverse bold>{" Enter "}</Text>
        <Text color={color.muted}> add repo </Text>
        <Text color={color.accent} inverse bold>{" Esc "}</Text>
        <Text color={color.muted}> clear </Text>
        <Text color={color.accent} inverse bold>{" q "}</Text>
        <Text color={color.muted}> quit (when empty)</Text>
      </Box>
    </Box>
  );
}
