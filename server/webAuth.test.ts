import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import express from "express";
import { configureWebAuth, readWebAuthConfig } from "./webAuth";

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function createHarness(config = {
  username: "operator",
  password: "correct horse battery staple",
  sessionSecret: "test-session-secret",
}) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());

  const auth = configureWebAuth(app, config);
  app.use("/api", auth.apiAccessMiddleware);
  app.get("/api/secret", (_req, res) => {
    res.json({ ok: true });
  });

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral test server address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      await closeServer(server);
    },
  };
}

test("readWebAuthConfig trims username and session secret but preserves password", () => {
  const config = readWebAuthConfig({
    OH_MY_PR_WEB_USERNAME: " operator ",
    OH_MY_PR_WEB_PASSWORD: "  password with spaces  ",
    OH_MY_PR_SESSION_SECRET: " secret ",
  });

  assert.deepEqual(config, {
    username: "operator",
    password: "  password with spaces  ",
    sessionSecret: "secret",
  });
});

test("loopback callers can use protected API routes without login", async () => {
  const harness = await createHarness();

  try {
    const response = await fetch(`${harness.baseUrl}/api/secret`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await harness.close();
  }
});

test("remote callers must log in before using protected API routes", async () => {
  const harness = await createHarness();
  const remoteHeaders = { "X-Forwarded-For": "203.0.113.10" };

  try {
    const blocked = await fetch(`${harness.baseUrl}/api/secret`, {
      headers: remoteHeaders,
    });
    assert.equal(blocked.status, 401);

    const login = await fetch(`${harness.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        ...remoteHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: "operator",
        password: "correct horse battery staple",
      }),
    });
    assert.equal(login.status, 200);
    assert.equal((await login.json() as { authenticated: boolean }).authenticated, true);

    const cookie = login.headers.get("set-cookie");
    assert.ok(cookie);

    const allowed = await fetch(`${harness.baseUrl}/api/secret`, {
      headers: {
        ...remoteHeaders,
        Cookie: cookie,
      },
    });
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { ok: true });
  } finally {
    await harness.close();
  }
});

test("logout clears remote API access for the current session", async () => {
  const harness = await createHarness();
  const remoteHeaders = { "X-Forwarded-For": "203.0.113.10" };

  try {
    const login = await fetch(`${harness.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        ...remoteHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: "operator",
        password: "correct horse battery staple",
      }),
    });
    const cookie = login.headers.get("set-cookie");
    assert.ok(cookie);

    const logout = await fetch(`${harness.baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: {
        ...remoteHeaders,
        Cookie: cookie,
      },
    });
    assert.equal(logout.status, 200);

    const blocked = await fetch(`${harness.baseUrl}/api/secret`, {
      headers: {
        ...remoteHeaders,
        Cookie: cookie,
      },
    });
    assert.equal(blocked.status, 401);
  } finally {
    await harness.close();
  }
});

test("remote callers cannot log in when credentials are not configured", async () => {
  const harness = await createHarness({});
  const remoteHeaders = { "X-Forwarded-For": "203.0.113.10" };

  try {
    const status = await fetch(`${harness.baseUrl}/api/auth/status`, {
      headers: remoteHeaders,
    });
    assert.deepEqual(await status.json(), {
      requiresLogin: true,
      loginConfigured: false,
      authenticated: false,
      username: null,
    });

    const response = await fetch(`${harness.baseUrl}/api/secret`, {
      headers: remoteHeaders,
    });
    assert.equal(response.status, 403);
  } finally {
    await harness.close();
  }
});
