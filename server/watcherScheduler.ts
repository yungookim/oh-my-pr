type WatcherErrorHandler = (error: unknown) => void;

export type WatcherScheduler = {
  run: () => Promise<void>;
};

export function createWatcherScheduler(
  task: () => Promise<void>,
  onError: WatcherErrorHandler,
): WatcherScheduler {
  let running = false;
  let rerunRequested = false;

  const run = async (): Promise<void> => {
    if (running) {
      rerunRequested = true;
      return;
    }

    running = true;

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
      running = false;
    }
  };

  return { run };
}
