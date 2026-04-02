import type { BackgroundJob } from "@shared/schema";
import { CancelBackgroundJobError, type BackgroundJobHandlers } from "./backgroundJobDispatcher";
import { answerPRQuestion } from "./prQuestionAgent";
import { generateSocialChangelog } from "./socialChangelogAgent";
import type { IStorage } from "./storage";

function readStringPayload(job: BackgroundJob, key: string): string | null {
  const value = job.payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function createBackgroundJobHandlers(params: {
  storage: IStorage;
  questionAnswerer?: typeof answerPRQuestion;
  socialChangelogGenerator?: typeof generateSocialChangelog;
}): BackgroundJobHandlers {
  const storage = params.storage;
  const questionAnswerer = params.questionAnswerer ?? answerPRQuestion;
  const socialChangelogGenerator = params.socialChangelogGenerator ?? generateSocialChangelog;

  return {
    answer_pr_question: async (job) => {
      const prId = readStringPayload(job, "prId");
      if (!prId) {
        throw new CancelBackgroundJobError(`Background job ${job.id} is missing question PR context`);
      }

      const question = (await storage.getQuestions(prId)).find((entry) => entry.id === job.targetId);
      if (!question) {
        throw new CancelBackgroundJobError(`PR question ${job.targetId} no longer exists`);
      }

      if (question.status === "answered" || question.status === "error") {
        return;
      }

      const config = await storage.getConfig();
      await questionAnswerer({
        storage,
        prId: question.prId,
        questionId: question.id,
        question: question.question,
        preferredAgent: config.codingAgent,
      });
    },

    generate_social_changelog: async (job) => {
      const changelog = await storage.getSocialChangelog(job.targetId);
      if (!changelog) {
        throw new CancelBackgroundJobError(`Social changelog ${job.targetId} no longer exists`);
      }

      if (changelog.status === "done" || changelog.status === "error") {
        return;
      }

      const config = await storage.getConfig();
      await socialChangelogGenerator({
        storage,
        changelogId: changelog.id,
        prSummaries: changelog.prSummaries,
        date: changelog.date,
        preferredAgent: config.codingAgent,
      });
    },
  };
}
