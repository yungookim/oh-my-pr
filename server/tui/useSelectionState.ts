import { useEffect, useState } from "react";

export type ActivePane = "prs" | "feedback" | "context";
export type ContextMode = "logs" | "ask" | "repos" | "settings";
export type InputMode = "none" | "ask" | "addRepo" | "addPr" | "addGithubToken";
export type ContextItemCounts = Record<ContextMode, number>;

export type SelectionState = {
  activePane: ActivePane;
  contextMode: ContextMode;
  selectedPrIndex: number;
  selectedFeedbackIndex: number;
  selectedContextIndex: number;
  feedbackActionIndex: number;
  setFeedbackActionIndex: (index: number) => void;
  expandedFeedbackIds: Set<string>;
  inputMode: InputMode;
  inputValue: string;
  cyclePane: () => void;
  setContextMode: (mode: ContextMode) => void;
  setSelectedPrIndex: (index: number) => void;
  setSelectedFeedbackIndex: (index: number) => void;
  moveUp: () => void;
  moveDown: () => void;
  toggleExpandedFeedback: (feedbackId: string) => void;
  beginInput: (mode: InputMode) => void;
  updateInput: (nextValue: string) => void;
  resetInput: () => void;
  setSelectedContextIndex: (index: number) => void;
};

function clampIndex(index: number, count: number): number {
  if (count <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(index, count - 1));
}

export function useSelectionState(params: {
  prCount: number;
  feedbackCount: number;
  contextItemCounts: ContextItemCounts;
}): SelectionState {
  const [activePane, setActivePane] = useState<ActivePane>("prs");
  const [contextMode, setContextModeState] = useState<ContextMode>("logs");
  const [selectedPrIndex, setSelectedPrIndexState] = useState(0);
  const [selectedFeedbackIndex, setSelectedFeedbackIndexState] = useState(0);
  const [selectedContextIndex, setSelectedContextIndexState] = useState(0);
  const [feedbackActionIndex, setFeedbackActionIndexState] = useState(0);
  const [expandedFeedbackIds, setExpandedFeedbackIds] = useState<Set<string>>(new Set());
  const [inputMode, setInputMode] = useState<InputMode>("none");
  const [inputValue, setInputValue] = useState("");
  const contextItemCount = params.contextItemCounts[contextMode];

  useEffect(() => {
    setSelectedPrIndexState((current) => clampIndex(current, params.prCount));
  }, [params.prCount]);

  useEffect(() => {
    setSelectedFeedbackIndexState((current) => clampIndex(current, params.feedbackCount));
  }, [params.feedbackCount]);

  useEffect(() => {
    setSelectedContextIndexState((current) => clampIndex(current, contextItemCount));
  }, [contextItemCount]);

  return {
    activePane,
    contextMode,
    selectedPrIndex,
    selectedFeedbackIndex,
    selectedContextIndex,
    feedbackActionIndex,
    setFeedbackActionIndex(index) {
      setFeedbackActionIndexState(Math.max(0, index));
    },
    expandedFeedbackIds,
    inputMode,
    inputValue,
    cyclePane() {
      setActivePane((current) => {
        if (current === "prs") {
          return "feedback";
        }

        if (current === "feedback") {
          return "context";
        }

        return "prs";
      });
    },
    setContextMode(mode) {
      setContextModeState(mode);
      setActivePane("context");
      setSelectedContextIndexState(0);
      setInputMode("none");
      setInputValue("");
    },
    setSelectedPrIndex(index) {
      setSelectedPrIndexState(clampIndex(index, params.prCount));
    },
    setSelectedFeedbackIndex(index) {
      setSelectedFeedbackIndexState(clampIndex(index, params.feedbackCount));
      setFeedbackActionIndexState(0);
    },
    moveUp() {
      if (activePane === "prs") {
        setSelectedPrIndexState((current) => clampIndex(current - 1, params.prCount));
        return;
      }

      if (activePane === "feedback") {
        setSelectedFeedbackIndexState((current) => clampIndex(current - 1, params.feedbackCount));
        setFeedbackActionIndexState(0);
        return;
      }

      setSelectedContextIndexState((current) => clampIndex(current - 1, contextItemCount));
    },
    moveDown() {
      if (activePane === "prs") {
        setSelectedPrIndexState((current) => clampIndex(current + 1, params.prCount));
        return;
      }

      if (activePane === "feedback") {
        setSelectedFeedbackIndexState((current) => clampIndex(current + 1, params.feedbackCount));
        setFeedbackActionIndexState(0);
        return;
      }

      setSelectedContextIndexState((current) => clampIndex(current + 1, contextItemCount));
    },
    toggleExpandedFeedback(feedbackId) {
      setExpandedFeedbackIds((current) => {
        const next = new Set(current);
        if (next.has(feedbackId)) {
          next.delete(feedbackId);
        } else {
          next.add(feedbackId);
        }
        return next;
      });
      setFeedbackActionIndexState(0);
    },
    beginInput(mode) {
      setInputMode(mode);
      setInputValue("");
    },
    updateInput(nextValue) {
      setInputValue(nextValue);
    },
    resetInput() {
      setInputMode("none");
      setInputValue("");
    },
    setSelectedContextIndex(index) {
      setSelectedContextIndexState(clampIndex(index, contextItemCount));
    },
  };
}
