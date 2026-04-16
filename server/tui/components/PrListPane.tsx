import React from "react";
import { Box, Text } from "ink";
import type { PR } from "@shared/schema";
import { color, glyph, prStatusGlyph, prStatusTone } from "../theme";
import {
  countActiveFeedbackStatuses,
  getViewportRange,
  isPRReadyToMerge,
  truncateText,
} from "../viewModel";

type PrListPaneProps = {
  prs: PR[];
  selectedPrIndex: number;
  active: boolean;
  width?: number;
  height?: number;
};

function padNumber(n: number, width: number): string {
  const str = `#${n}`;
  return str.length >= width ? str : `${" ".repeat(width - str.length)}${str}`;
}

type Badge = { label: string; tone: string };

function getBadges(pr: PR): Badge[] {
  const badges: Badge[] = [];
  const counts = countActiveFeedbackStatuses(pr.feedbackItems);

  if (counts.failed > 0) badges.push({ label: `${counts.failed}!`, tone: color.err });
  if (counts.warning > 0) badges.push({ label: `${counts.warning}⚠`, tone: color.warn });
  if (counts.inProgress > 0) badges.push({ label: `${counts.inProgress}◐`, tone: color.info });
  if (counts.queued > 0) badges.push({ label: `${counts.queued}○`, tone: color.accent });
  if (!pr.watchEnabled) badges.push({ label: "paused", tone: color.muted });
  if (isPRReadyToMerge(pr.feedbackItems) && pr.status !== "processing") {
    badges.push({ label: "ready", tone: color.ok });
  }
  return badges;
}

function PrRow(props: { pr: PR; selected: boolean; width: number }) {
  const { pr, selected, width } = props;
  const badges = getBadges(pr);
  const numCol = padNumber(pr.number, 5);
  const badgesText = badges.map((b) => b.label).join(" ");
  const summary = truncateText(
    [
      `${prStatusGlyph(pr.status)} ${numCol}`,
      pr.title,
      badgesText,
    ].filter(Boolean).join(" "),
    width - 2,
  );

  return (
    <Text color={selected ? color.accent : prStatusTone(pr.status)} bold={selected} wrap="truncate-end">
      {selected ? `${glyph.focus} ` : "  "}
      {summary}
    </Text>
  );
}

export function PrListPane(props: PrListPaneProps) {
  const borderColor = props.active ? color.accent : color.muted;
  const innerWidth = (props.width ?? 40) - 4;
  const rowCount = Math.max(3, (props.height ?? 16) - 4);
  const viewport = getViewportRange(props.prs.length, props.selectedPrIndex, rowCount);
  const visiblePrs = props.prs.slice(viewport.start, viewport.end);

  return (
    <Box
      flexDirection="column"
      borderStyle={props.active ? "round" : "single"}
      borderColor={borderColor}
      paddingX={1}
      width={props.width}
      height={props.height}
    >
      <Box>
        <Text bold color={props.active ? color.accent : undefined}>
          Pull Requests
        </Text>
        <Text color={color.muted}>{`  ${props.prs.length}`}</Text>
        {(viewport.hiddenAbove > 0 || viewport.hiddenBelow > 0) && (
          <Text color={color.muted}>{`  ↑${viewport.hiddenAbove} ↓${viewport.hiddenBelow}`}</Text>
        )}
      </Box>
      {props.prs.length === 0 ? (
        <Text color={color.muted}>No tracked PRs.</Text>
      ) : (
        visiblePrs.map((pr, index) => (
          <PrRow
            key={pr.id}
            pr={pr}
            selected={viewport.start + index === props.selectedPrIndex}
            width={innerWidth}
          />
        ))
      )}
    </Box>
  );
}
