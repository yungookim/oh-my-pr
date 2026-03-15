type WatcherErrorHandler = (error: unknown) => void;

export type WatcherScheduler = {
  run: () => Promise<void>;
};

export function createWatcherScheduler(
  task: () => Promise<void>,
  onError: WatcherErrorHandler,
): WatcherScheduler {
  let activeRun: Promise<void> | null = null;
  let rerunRequested = false;

  const run = (): Promise<void> => {
    if (activeRun) {
      rerunRequested = true;
      return activeRun;
    }

    activeRun = (async () => {
      try {
        do {
          rerunRequested = false;

          try {
            await task();
          } catch (error) {
            onError(error);
          }
        } while (rerunRequested);
      } finally {
        activeRun = null;
      }
    })();

    return activeRun;
  };

  return { run };
}
