import crypto from "node:crypto";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import session from "express-session";
import createMemoryStore from "memorystore";
import { rateLimit } from "express-rate-limit";
import { isLoopbackAddress } from "./localOnly";

const USERNAME_ENV = "OH_MY_PR_WEB_USERNAME";
const PASSWORD_ENV = "OH_MY_PR_WEB_PASSWORD";
const SESSION_SECRET_ENV = "OH_MY_PR_SESSION_SECRET";
const SESSION_NAME = "oh-my-pr.sid";
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const MemoryStore = createMemoryStore(session);

declare module "express-session" {
  interface SessionData {
    authenticatedWebUser?: string;
  }
}

export interface WebAuthConfig {
  username?: string;
  password?: string;
  sessionSecret?: string;
}

interface WebAuthCredentials {
  username: string;
  password: string;
}

interface AuthStatus {
  requiresLogin: boolean;
  loginConfigured: boolean;
  authenticated: boolean;
  username: string | null;
}

export interface WebAuthHandlers {
  apiAccessMiddleware: RequestHandler;
}

function trimEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function readWebAuthConfig(env: NodeJS.ProcessEnv = process.env): WebAuthConfig {
  return {
    username: trimEnv(env[USERNAME_ENV]),
    password: env[PASSWORD_ENV],
    sessionSecret: trimEnv(env[SESSION_SECRET_ENV]),
  };
}

function getCredentials(config: WebAuthConfig): WebAuthCredentials | null {
  if (!config.username || !config.password) {
    return null;
  }

  return {
    username: config.username,
    password: config.password,
  };
}

function getRequestIp(req: Request): string | undefined {
  return req.ip ?? req.socket?.remoteAddress;
}

function isLoopbackRequest(req: Request): boolean {
  return isLoopbackAddress(getRequestIp(req));
}

function safeEqual(actual: string, expected: string): boolean {
  const actualHash = crypto.createHash("sha256").update(actual).digest();
  const expectedHash = crypto.createHash("sha256").update(expected).digest();

  return crypto.timingSafeEqual(actualHash, expectedHash);
}

function buildAuthStatus(req: Request, credentials: WebAuthCredentials | null): AuthStatus {
  const requiresLogin = !isLoopbackRequest(req);
  const sessionUser = req.session?.authenticatedWebUser ?? null;
  const authenticated = !requiresLogin || Boolean(credentials && sessionUser === credentials.username);

  return {
    requiresLogin,
    loginConfigured: credentials !== null,
    authenticated,
    username: authenticated && credentials ? credentials.username : null,
  };
}

function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function destroySession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function buildSessionPhaseError(phase: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Web auth ${phase} failed: ${message}`, { cause: error });
}

export function configureWebAuth(app: Express, config = readWebAuthConfig()): WebAuthHandlers {
  const credentials = getCredentials(config);
  const sessionSecret = config.sessionSecret ?? crypto.randomBytes(32).toString("hex");

  app.use(
    session({
      name: SESSION_NAME,
      secret: sessionSecret,
      store: new MemoryStore({
        checkPeriod: SESSION_MAX_AGE_MS,
      }),
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: SESSION_MAX_AGE_MS,
      },
    }),
  );

  const loginLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.get("/api/auth/status", (req, res) => {
    res.json(buildAuthStatus(req, credentials));
  });

  app.post("/api/auth/login", loginLimiter, async (req, res, next) => {
    if (!credentials) {
      res.status(403).json({
        error: "Remote login is not configured",
        message: `Set ${USERNAME_ENV} and ${PASSWORD_ENV} before using remote web access.`,
      });
      return;
    }

    const username = typeof req.body?.username === "string" ? req.body.username : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!safeEqual(username, credentials.username) || !safeEqual(password, credentials.password)) {
      res.status(401).json({
        error: "Invalid credentials",
        message: "Username or password is incorrect.",
      });
      return;
    }

    let phase = "session regeneration";
    try {
      await regenerateSession(req);
      req.session.authenticatedWebUser = credentials.username;
      phase = "session save";
      await saveSession(req);
    } catch (error) {
      next(buildSessionPhaseError(phase, error));
      return;
    }

    res.json(buildAuthStatus(req, credentials));
  });

  app.post("/api/auth/logout", async (req, res, next) => {
    try {
      if (req.session.authenticatedWebUser) {
        await destroySession(req);
        res.clearCookie(SESSION_NAME);
      }
    } catch (error) {
      next(buildSessionPhaseError("session destroy", error));
      return;
    }

    res.json(buildAuthStatus(req, credentials));
  });

  return {
    apiAccessMiddleware(req: Request, res: Response, next: NextFunction): void {
      if (isLoopbackRequest(req)) {
        next();
        return;
      }

      if (!credentials) {
        res.status(403).json({
          error: "Remote access is not configured",
          message: `Set ${USERNAME_ENV} and ${PASSWORD_ENV} to allow remote dashboard login.`,
        });
        return;
      }

      if (req.session?.authenticatedWebUser === credentials.username) {
        next();
        return;
      }

      res.status(401).json({
        error: "Login required",
        message: "Sign in to use oh-my-pr from this network address.",
      });
    },
  };
}
