import React from "react";
import { Box, Text } from "ink";
import type { PRQuestion } from "@shared/schema";
import { wrapText } from "../viewModel";

export function AskPane(props: {
  questions: PRQuestion[];
  inputMode: boolean;
  inputValue: string;
  width: number;
}) {
  return (
    <Box flexDirection="column">
      {props.questions.length === 0 ? (
        <Text dimColor>Press Enter to ask about the selected PR.</Text>
      ) : props.questions.slice(-6).map((question) => (
        <Box key={question.id} flexDirection="column" marginBottom={1}>
          <Text color="cyan">Q: {question.question}</Text>
          {question.status === "answered" && question.answer ? (
            wrapText(question.answer, Math.max(20, props.width - 4)).map((line, index) => (
              <Text key={`${question.id}-${index}`}>{line}</Text>
            ))
          ) : question.status === "error" ? (
            <Text color="red">Error: {question.error ?? "Unknown error"}</Text>
          ) : (
            <Text dimColor>Agent is thinking...</Text>
          )}
        </Box>
      ))}
      <Text color={props.inputMode ? "green" : undefined}>
        {props.inputMode ? `Ask: ${props.inputValue || "…"}` : "Enter to compose a question"}
      </Text>
    </Box>
  );
}
