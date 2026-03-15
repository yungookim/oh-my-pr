import test from "node:test";
import assert from "node:assert/strict";
import { createWatcherScheduler } from "./watcherScheduler";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return {
    promise,
    resolve,
  };
}

test("createWatcherScheduler reruns once when triggered during an active run", async () => {
  const firstStarted = deferred();
  const releaseFirstRun = deferred();
  const secondStarted = deferred();
  const errors: unknown[] = [];
  let runCount = 0;

  const scheduler = createWatcherScheduler(async () => {
    runCount += 1;

    if (runCount === 1) {
      firstStarted.resolve();
      await releaseFirstRun.promise;
      return;
    }

    if (runCount === 2) {
      secondStarted.resolve();
      return;
    }

    throw new Error(`unexpected run ${runCount}`);
  }, (error) => {
    errors.push(error);
  });

  const initialRun = scheduler.run();
  await firstStarted.promise;

  const queuedRun = scheduler.run();
  const duplicateQueuedRun = scheduler.run();

  releaseFirstRun.resolve();

  await secondStarted.promise;
  await Promise.all([initialRun, queuedRun, duplicateQueuedRun]);

  assert.equal(runCount, 2);
  assert.deepEqual(errors, []);
});
