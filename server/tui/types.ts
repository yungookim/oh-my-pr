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
  | "listRepoSettings"
  | "getConfig"
  | "queueBabysit"
  | "setWatchEnabled"
  | "setFeedbackDecision"
  | "retryFeedback"
  | "askQuestion"
  | "addRepo"
  | "addPR"
  | "updateConfig"
  | "updateRepoSettings"
  | "syncRepos"
>;

export type TuiRuntimeSnapshot = RuntimeSnapshot;
