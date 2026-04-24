import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { localOnlyMiddleware } from "./localOnly";
import { createServer } from "http";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// Restrict every /api route to local-machine callers only.
// Any request arriving from a non-loopback IP is rejected with 403.
app.use("/api", localOnlyMiddleware);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}

async function openDashboard(url: string) {
  const { default: open } = await import("open");
  await open(url);
}

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const error = err as Partial<Error> & {
      status?: number;
      statusCode?: number;
    };
    const status = error.status || error.statusCode || 500;
    const message = error.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5001 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5001", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
    },
    () => {
      const url = `http://localhost:${port}`;
      const version = process.env.APP_VERSION || "dev";

      if (process.env.NODE_ENV === "production") {
        console.log(`\n  oh-my-pr v${version}\n  Dashboard: ${url}\n`);
      } else {
        log(`serving on port ${port}`);
      }

      // Auto-open browser (skip when Tauri manages the window)
      if (!process.env.TAURI_DEV && !process.env.OH_MY_PR_DESKTOP) {
        openDashboard(url).catch((err) => {
          log(`Could not open browser automatically: ${err.message}`);
        });
      }
    },
  );
})();
