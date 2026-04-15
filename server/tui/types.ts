import type { AppRuntime, RuntimeSnapshot } from "../appRuntime";

export type TuiRuntime = Pick<
  AppRuntime,
  | "subscribe"
  | "getRuntimeSnapshot"
  | "listPRs"
  | "getPR"
  | "listLogs"
  | "listPRQuestions"
  | "listRepos"
  | "getConfig"
  | "queueBabysit"
  | "setWatchEnabled"
  | "setFeedbackDecision"
  | "retryFeedback"
  | "askQuestion"
  | "addRepo"
  | "addPR"
  | "updateConfig"
  | "syncRepos"
>;

export type TuiRuntimeSnapshot = RuntimeSnapshot;
