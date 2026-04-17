import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { Config, FeedbackItem } from "@shared/schema";
import { useRuntimeSnapshot } from "./useRuntimeSnapshot";
import { type ContextMode, useSelectionState } from "./useSelectionState";
import type { TuiRuntime } from "./types";
import { getFeedbackActions, getLayoutMode } from "./viewModel";
import { Header } from "./components/Header";
import { PrListPane } from "./components/PrListPane";
import { PrDetailPane } from "./components/PrDetailPane";
import { ContextPane } from "./components/ContextPane";
import { Footer } from "./components/Footer";
import { OnboardingScreen } from "./components/OnboardingScreen";
import { color, glyph } from "./theme";

type AppProps = {
  runtime: TuiRuntime;
  screenWidth?: number;
  screenHeight?: number;
  refreshMs?: number;
};

function getContextItemCount(contextMode: ContextMode): number {
  if (contextMode === "repos") {
    return 3;
  }

  if (contextMode === "settings") {
    return 4;
  }

  return 0;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function App(props: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const width = props.screenWidth ?? stdout.columns ?? 160;
  const height = props.screenHeight ?? stdout.rows ?? 40;
  const layoutMode = getLayoutMode(width);

  const [selectedPrId, setSelectedPrId] = useState<string | null>(null);
  const [onboardingValue, setOnboardingValue] = useState("");
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [onboardingSubmitting, setOnboardingSubmitting] = useState(false);
  const snapshot = useRuntimeSnapshot(props.runtime, selectedPrId, props.refreshMs ?? 1500);
  const selection = useSelectionState({
    prCount: snapshot.prs.length,
    feedbackCount: snapshot.selectedPr?.feedbackItems.length ?? 0,
    contextItemCount: 4,
  });
  const contextItemCount = getContextItemCount(selection.contextMode);

  useEffect(() => {
    if (snapshot.prs.length === 0) {
      setSelectedPrId(null);
      return;
    }

    const nextSelectedPr = snapshot.prs[selection.selectedPrIndex] ?? snapshot.prs[0];
    setSelectedPrId(nextSelectedPr?.id ?? null);
  }, [snapshot.prs, selection.selectedPrIndex]);

  useEffect(() => {
    if (selection.selectedContextIndex >= contextItemCount) {
      selection.setSelectedContextIndex(Math.max(0, contextItemCount - 1));
    }
  }, [contextItemCount, selection]);

  const selectedPr = snapshot.selectedPr ?? snapshot.prs[selection.selectedPrIndex] ?? null;
  const selectedFeedback = selectedPr?.feedbackItems[selection.selectedFeedbackIndex] ?? null;
  const selectedFeedbackExpanded = selectedFeedback ? selection.expandedFeedbackIds.has(selectedFeedback.id) : false;
  const selectedFeedbackActions = selectedFeedback
    ? (selectedFeedbackExpanded ? ["Collapse", ...getFeedbackActions(selectedFeedback)] : getFeedbackActions(selectedFeedback))
    : [];
  const selectedActionIndex = Math.min(selection.feedbackActionIndex, Math.max(0, selectedFeedbackActions.length - 1));
  const needsOnboarding = !snapshot.loading
    && Boolean(snapshot.config)
    && snapshot.config!.watchedRepos.length === 0
    && snapshot.prs.length === 0;

  const setStatus = (message: string | null) => {
    setStatusMessage(message);
    setActionError(null);
  };

  const handleFailure = (error: unknown) => {
    setActionError(getErrorMessage(error));
  };

  const submitOnboarding = async () => {
    if (onboardingSubmitting) {
      return;
    }

    const value = onboardingValue.trim();
    if (!value) {
      return;
    }

    setOnboardingSubmitting(true);
    try {
      await props.runtime.addRepo(value);
      setOnboardingError(null);
      setOnboardingValue("");
      setStatus("Repository added");
    } catch (error) {
      setOnboardingError(getErrorMessage(error));
    } finally {
      setOnboardingSubmitting(false);
    }
  };

  const applyFeedbackAction = async (item: FeedbackItem) => {
    const action = selectedFeedbackActions[selectedActionIndex];
    if (!selectedPr || !action) {
      return;
    }

    try {
      if (action === "Collapse") {
        selection.toggleExpandedFeedback(item.id);
        return;
      }

      if (action === "Retry") {
        await props.runtime.retryFeedback(selectedPr.id, item.id);
        setStatus("Queued feedback retry");
        return;
      }

      const decision = action.toLowerCase() as "accept" | "reject" | "flag";
      await props.runtime.setFeedbackDecision(selectedPr.id, item.id, decision);
      setStatus(`Marked feedback as ${decision}`);
    } catch (error) {
      handleFailure(error);
    }
  };

  const submitInput = async () => {
    if (!selectedPr && selection.inputMode === "ask") {
      setActionError("Select a PR first");
      return;
    }

    const value = selection.inputValue.trim();
    if (!value) {
      selection.resetInput();
      return;
    }

    try {
      if (selection.inputMode === "ask" && selectedPr) {
        await props.runtime.askQuestion(selectedPr.id, value);
        setStatus("Queued agent question");
      } else if (selection.inputMode === "addRepo") {
        await props.runtime.addRepo(value);
        setStatus("Repository added");
      } else if (selection.inputMode === "addPr") {
        await props.runtime.addPR(value);
        setStatus("PR added");
      }
    } catch (error) {
      handleFailure(error);
    } finally {
      selection.resetInput();
    }
  };

  const toggleSetting = async () => {
    if (!snapshot.config) {
      return;
    }

    const current = snapshot.config;
    let updates: Partial<Config> | null = null;

    if (selection.selectedContextIndex === 0) {
      updates = { codingAgent: current.codingAgent === "claude" ? "codex" : "claude" };
    } else if (selection.selectedContextIndex === 1) {
      updates = { autoResolveMergeConflicts: !current.autoResolveMergeConflicts };
    } else if (selection.selectedContextIndex === 2) {
      updates = { autoUpdateDocs: !current.autoUpdateDocs };
    } else if (selection.selectedContextIndex === 3) {
      updates = {
        includeRepositoryLinksInGitHubComments: !current.includeRepositoryLinksInGitHubComments,
      };
    }

    if (!updates) {
      return;
    }

    try {
      await props.runtime.updateConfig(updates);
      setStatus("Settings updated");
    } catch (error) {
      handleFailure(error);
    }
  };

  const handleContextEnter = async () => {
    if (selection.contextMode === "ask") {
      selection.beginInput("ask");
      return;
    }

    if (selection.contextMode === "repos") {
      if (selection.selectedContextIndex === 0) {
        try {
          await props.runtime.syncRepos();
          setStatus("Repository sync queued");
        } catch (error) {
          handleFailure(error);
        }
        return;
      }

      if (selection.selectedContextIndex === 1) {
        selection.beginInput("addRepo");
        return;
      }

      if (selection.selectedContextIndex === 2) {
        selection.beginInput("addPr");
      }
      return;
    }

    if (selection.contextMode === "settings") {
      await toggleSetting();
    }
  };

  useInput((input, key) => {
    if (needsOnboarding) {
      if (key.escape) {
        setOnboardingValue("");
        setOnboardingError(null);
        return;
      }

      if (key.return) {
        void submitOnboarding();
        return;
      }

      if (key.backspace || key.delete) {
        setOnboardingValue((current) => current.slice(0, -1));
        setOnboardingError(null);
        return;
      }

      if (input === "q" && onboardingValue.length === 0) {
        exit();
        return;
      }

      if (!key.ctrl && !key.meta && input) {
        setOnboardingValue((current) => `${current}${input}`);
        setOnboardingError(null);
      }
      return;
    }

    if (selection.inputMode !== "none") {
      if (key.escape) {
        selection.resetInput();
        return;
      }

      if (key.return) {
        void submitInput();
        return;
      }

      if (key.backspace || key.delete) {
        selection.updateInput(selection.inputValue.slice(0, -1));
        return;
      }

      if (!key.ctrl && !key.meta && input) {
        selection.updateInput(`${selection.inputValue}${input}`);
      }
      return;
    }

    if (key.tab) {
      selection.cyclePane();
      return;
    }

    if (input === "q") {
      exit();
      return;
    }

    if (input === "l") {
      selection.setContextMode("logs");
      return;
    }

    if (input === "a") {
      selection.setContextMode("ask");
      return;
    }

    if (input === "o") {
      selection.setContextMode("repos");
      return;
    }

    if (input === "s") {
      selection.setContextMode("settings");
      return;
    }

    if (input === "r" && selectedPr) {
      void props.runtime.queueBabysit(selectedPr.id)
        .then(() => {
          setStatus("Queued babysitter run");
        })
        .catch(handleFailure);
      return;
    }

    if (input === "w" && selectedPr) {
      void props.runtime.setWatchEnabled(selectedPr.id, !selectedPr.watchEnabled)
        .then(() => {
          setStatus(selectedPr.watchEnabled ? "Watch paused" : "Watch resumed");
        })
        .catch(handleFailure);
      return;
    }

    if (key.upArrow) {
      selection.moveUp();
      return;
    }

    if (key.downArrow) {
      selection.moveDown();
      return;
    }

    if (key.leftArrow && selectedFeedback) {
      selection.setFeedbackActionIndex(Math.max(0, selectedActionIndex - 1));
      return;
    }

    if (key.rightArrow && selectedFeedback) {
      selection.setFeedbackActionIndex(Math.min(selectedFeedbackActions.length - 1, selectedActionIndex + 1));
      return;
    }

    if (key.return) {
      if (selection.activePane === "feedback" && selectedFeedback) {
        if (!selection.expandedFeedbackIds.has(selectedFeedback.id)) {
          selection.toggleExpandedFeedback(selectedFeedback.id);
          return;
        }

        void applyFeedbackAction(selectedFeedback);
        return;
      }

      if (selection.activePane === "context") {
        void handleContextEnter();
      }
    }
  }, { isActive: true });

  const paneLayout = useMemo(() => {
    const mainHeight = Math.max(layoutMode === "stacked" ? 22 : 12, height - 6);

    if (layoutMode === "full") {
      return {
        widths: {
          list: 40,
          context: 48,
        },
        heights: {
          list: mainHeight,
          detail: mainHeight,
          context: mainHeight,
        },
      };
    }

    const listHeight = Math.max(7, Math.floor(mainHeight * 0.25));
    const contextHeight = Math.max(7, Math.floor(mainHeight * 0.3));
    const detailHeight = Math.max(8, mainHeight - listHeight - contextHeight);

    return {
      widths: {
        list: width,
        context: width,
      },
      heights: {
        list: listHeight,
        detail: detailHeight,
        context: contextHeight,
      },
    };
  }, [height, layoutMode, width]);

  if (layoutMode === "compact-warning") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={color.warn} paddingX={1}>
        <Text>
          <Text color={color.accent} bold>{glyph.focus} </Text>
          <Text bold>oh-my-pr</Text>
        </Text>
        <Text color={color.warn}>Window too narrow for the terminal UI.</Text>
        <Text color={color.muted}>Resize to at least 110 columns.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header
        runtime={snapshot.runtime}
        config={snapshot.config}
        repoCount={snapshot.repos.length}
        prCount={snapshot.prs.length}
        activePane={selection.activePane}
        contextMode={selection.contextMode}
      />
      {snapshot.loading ? (
        <Box borderStyle="round" borderColor={color.muted} paddingX={1}>
          <Text color={color.info}>{glyph.running} </Text>
          <Text>Loading TUI…</Text>
        </Box>
      ) : needsOnboarding ? (
        <OnboardingScreen
          value={onboardingValue}
          errorMessage={onboardingError}
          submitting={onboardingSubmitting}
        />
      ) : (
        <Box flexDirection={layoutMode === "stacked" ? "column" : "row"}>
          <PrListPane
            prs={snapshot.prs}
            selectedPrIndex={selection.selectedPrIndex}
            active={selection.activePane === "prs"}
            width={paneLayout.widths.list}
            height={paneLayout.heights.list}
          />
          <PrDetailPane
            pr={selectedPr}
            selectedFeedbackIndex={selection.selectedFeedbackIndex}
            active={selection.activePane === "feedback"}
            expandedFeedbackIds={selection.expandedFeedbackIds}
            selectedActionIndex={selectedActionIndex}
            selectedActions={selectedFeedbackActions}
            width={layoutMode === "full" ? width - paneLayout.widths.list! - paneLayout.widths.context! : undefined}
            height={paneLayout.heights.detail}
          />
          <ContextPane
            mode={selection.contextMode}
            active={selection.activePane === "context"}
            width={paneLayout.widths.context}
            height={paneLayout.heights.context}
            logs={snapshot.logs}
            questions={snapshot.questions}
            repos={snapshot.repos}
            config={snapshot.config}
            selectedContextIndex={selection.selectedContextIndex}
            inputMode={selection.inputMode}
            inputValue={selection.inputValue}
          />
        </Box>
      )}
      {!needsOnboarding && (
        <Footer
          contextMode={selection.contextMode}
          statusMessage={statusMessage}
          errorMessage={actionError ?? snapshot.error}
          width={width}
        />
      )}
    </Box>
  );
}
