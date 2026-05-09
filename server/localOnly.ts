/**
 * localOnly.ts
 *
 * Express helpers for recognizing requests originating from the local machine
 * (127.0.0.1 / ::1 / ::ffff:127.0.0.1).
 *
 * The middleware below preserves the strict local-only behavior for callers
 * that need it. The web server uses the exported loopback helper so local
 * callers can bypass dashboard login while remote callers authenticate.
 *
 * Usage
 * -----
 *   import { localOnlyMiddleware } from "./localOnly";
 *   app.use("/api", localOnlyMiddleware);
 */

import type { Request, Response, NextFunction } from "express";

/** Loopback addresses we consider "local". */
const LOOPBACK_ADDRESSES = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
  "localhost",
]);

/**
 * Returns `true` when the raw IP string is a loopback address.
 * Handles IPv4, IPv6, and IPv4-mapped IPv6 (::ffff:127.x.x.x).
 */
export function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;

  // Strip brackets from IPv6 literals (e.g. "[::1]")
  const cleaned = ip.replace(/^\[|\]$/g, "");

  if (LOOPBACK_ADDRESSES.has(cleaned)) return true;

  // IPv4-mapped IPv6 range: ::ffff:127.0.0.0/8
  if (cleaned.startsWith("::ffff:")) {
    const v4 = cleaned.slice("::ffff:".length);
    return v4.startsWith("127.");
  }

  // Plain IPv4 loopback: 127.0.0.0/8
  if (cleaned.startsWith("127.")) return true;

  return false;
}

/**
 * Express middleware – rejects non-loopback callers with 403.
 *
 * Mount this before any route you want to protect:
 *   app.use("/api", localOnlyMiddleware);
 */
export function localOnlyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Express sets req.ip after trust-proxy resolution; fall back to socket address.
  const ip = req.ip ?? req.socket?.remoteAddress;

  if (!isLoopbackAddress(ip)) {
    res.status(403).json({
      error: "Forbidden",
      message:
        "oh-my-pr only accepts connections from the local machine. " +
        "External access is not permitted.",
    });
    return;
  }

  next();
}
