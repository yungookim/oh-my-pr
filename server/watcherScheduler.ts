type WatcherErrorHandler = (error: unknown) => void;

export type WatcherScheduler = {
  run: () => Promise<void>;
  runAndReportErrors: () => Promise<void>;
};

export function createWatcherScheduler(
  task: () => Promise<void>,
  onError: WatcherErrorHandler,
): WatcherScheduler {
  let activeRun: Promise<void> | null = null;
  let rerunRequested = false;
  let runErrors: unknown[] = [];
  let waiters: Array<{
    propagateErrors: boolean;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];

  const settleWaiters = (errors: unknown[]) => {
    const pendingWaiters = waiters;
    waiters = [];
    const firstError = errors[0];

    for (const waiter of pendingWaiters) {
      if (waiter.propagateErrors && firstError !== undefined) {
        waiter.reject(firstError);
        continue;
      }

      waiter.resolve();
    }
  };

  const queueRun = (propagateErrors: boolean): Promise<void> => {
    const completion = new Promise<void>((resolve, reject) => {
      waiters.push({ propagateErrors, resolve, reject });
    });

    if (activeRun) {
      rerunRequested = true;
      return completion;
    }

    runErrors = [];
    activeRun = (async () => {
      try {
        do {
          rerunRequested = false;

          try {
            await task();
          } catch (error) {
            runErrors.push(error);
            onError(error);
          }
        } while (rerunRequested);
      } finally {
        const errors = runErrors;
        runErrors = [];
        activeRun = null;
        settleWaiters(errors);
      }
    })();

    return completion;
  };

  return {
    run: () => queueRun(false),
    runAndReportErrors: () => queueRun(true),
  };
}
