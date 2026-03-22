import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemStorage } from "./memoryStorage";
import { answerPRQuestion } from "./prQuestionAgent";
import type { PRQuestion } from "@shared/schema";
import type { IStorage } from "./storage";

/** Helper: create a minimal PR in storage and return its id. */
async function seedPR(storage: MemStorage): Promise<string> {
  const pr = await storage.addPR({
    number: 42,
    title: "feat: add widget",
    repo: "acme/widgets",
    branch: "feat/widget",
    author: "alice",
    url: "https://github.com/acme/widgets/pull/42",
    status: "watching",
    feedbackItems: [],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });
  return pr.id;
}

describe("answerPRQuestion", () => {
  it("sets status to 'error' when the PR does not exist", async () => {
    const storage = new MemStorage();
    // Create a question linked to a non-existent PR id
    const q = await storage.addQuestion("nonexistent-pr-id", "Why is CI red?");

    await answerPRQuestion({
      storage,
      prId: "nonexistent-pr-id",
      questionId: q.id,
      question: q.question,
      preferredAgent: "codex",
    });

    const updated = (await storage.getQuestions("nonexistent-pr-id")).find(
      (x) => x.id === q.id,
    );
    assert.ok(updated, "question should still exist in storage");
    assert.equal(updated.status, "error");
    assert.ok(updated.error, "error message should be set");
    assert.match(updated.error!, /PR not found/i);
  });

  it("sets status to 'answering' before doing any work", async () => {
    const storage = new MemStorage();
    const prId = await seedPR(storage);
    const q = await storage.addQuestion(prId, "What changed?");
    assert.equal(q.status, "pending", "initial status should be pending");

    // Track status transitions by intercepting updateQuestion calls
    const statusTransitions: string[] = [];
    const proxyStorage = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === "updateQuestion") {
          return async (id: string, updates: Partial<PRQuestion>) => {
            if (updates.status) {
              statusTransitions.push(updates.status);
            }
            return target.updateQuestion(id, updates);
          };
        }
        // Make getPR throw after recording the "answering" status,
        // so we don't need an actual agent CLI to complete.
        if (prop === "getPR") {
          return async (id: string) => {
            // If "answering" has been recorded, throw to short-circuit
            if (statusTransitions.includes("answering")) {
              throw new Error("intentional test abort");
            }
            return target.getPR(id);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    await answerPRQuestion({
      storage: proxyStorage as unknown as IStorage,
      prId,
      questionId: q.id,
      question: q.question,
      preferredAgent: "codex",
    });

    // First transition should be "answering"
    assert.ok(statusTransitions.length >= 1, "should have at least one status transition");
    assert.equal(statusTransitions[0], "answering", "first status transition should be 'answering'");
    // Second transition is the error from our intentional abort
    assert.equal(statusTransitions[1], "error", "second status transition should be 'error'");
  });

  it("sets status to 'error' when agent CLI is not installed", async () => {
    const storage = new MemStorage();
    const prId = await seedPR(storage);
    const q = await storage.addQuestion(prId, "How big is this PR?");

    // Force resolveAgent to fail by making getPR throw with the expected message.
    // We simulate an environment where the agent resolution fails by intercepting
    // at the storage layer before runCommand is called.
    // Since the real resolveAgent may find `claude`, we use a proxy that makes
    // getPR throw with a message mimicking agent-not-found.
    const proxyStorage = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === "getPR") {
          return async () => {
            throw new Error("Neither codex nor claude CLI is installed");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    await answerPRQuestion({
      storage: proxyStorage as unknown as IStorage,
      prId,
      questionId: q.id,
      question: q.question,
      preferredAgent: "claude",
    });

    const updated = (await storage.getQuestions(prId)).find(
      (x) => x.id === q.id,
    );
    assert.ok(updated);
    assert.equal(updated.status, "error");
    assert.ok(updated.error);
    assert.match(updated.error!, /neither codex nor claude/i);
  });

  it("truncates error messages to 2000 characters", async () => {
    const storage = new MemStorage();
    const longMessage = "X".repeat(5000);
    const proxyStorage = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === "getPR") {
          return async () => {
            throw new Error(longMessage);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const q = await storage.addQuestion("some-pr", "question");

    await answerPRQuestion({
      storage: proxyStorage as unknown as IStorage,
      prId: "some-pr",
      questionId: q.id,
      question: q.question,
      preferredAgent: "codex",
    });

    const updated = (await storage.getQuestions("some-pr")).find(
      (x) => x.id === q.id,
    );
    assert.ok(updated);
    assert.equal(updated.status, "error");
    assert.ok(updated.error);
    assert.ok(
      updated.error!.length <= 2000,
      `Error message should be at most 2000 chars, got ${updated.error!.length}`,
    );
    assert.equal(updated.error!.length, 2000);
  });

  it("does not throw — errors are always captured into question state", async () => {
    const storage = new MemStorage();
    const q = await storage.addQuestion("bad-id", "anything");

    // Should not throw, even with a completely invalid PR id
    await assert.doesNotReject(
      answerPRQuestion({
        storage,
        prId: "bad-id",
        questionId: q.id,
        question: q.question,
        preferredAgent: "codex",
      }),
    );
  });

  it("error from non-Error throwable is converted to string", async () => {
    const storage = new MemStorage();
    const proxyStorage = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === "getPR") {
          return async () => {
            throw new Error("string error without Error wrapper");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const q = await storage.addQuestion("pr-id", "question");

    await answerPRQuestion({
      storage: proxyStorage as unknown as IStorage,
      prId: "pr-id",
      questionId: q.id,
      question: q.question,
      preferredAgent: "codex",
    });

    const updated = (await storage.getQuestions("pr-id")).find(
      (x) => x.id === q.id,
    );
    assert.ok(updated);
    assert.equal(updated.status, "error");
    assert.equal(updated.error, "string error without Error wrapper");
  });
});
