import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Configure logger destination BEFORE first import.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ompr-log-"));
const LOG_FILE = path.join(TMP_DIR, "server.log");
process.env.OH_MY_PR_LOG_FILE = LOG_FILE;
process.env.LOG_LEVEL = "info";
process.env.NODE_ENV = "production";

const { logger, sanitizeString, readRingBuffer, _resetRingBufferForTests, _writeRingChunkForTests } = await import("./logger");

function flushAndRead(expected?: RegExp): Promise<string> {
  return new Promise((resolve) => {
    let attempts = 0;
    const read = () => fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8") : "";
    const poll = () => {
      attempts += 1;
      const content = read();
      if (!expected || expected.test(content) || attempts >= 40) {
        resolve(content);
        return;
      }
      setTimeout(poll, 25);
    };
    setTimeout(poll, 25);
  });
}

test("sanitizeString redacts ghp_/gho_/ghs_ tokens", () => {
  const out = sanitizeString("auth=ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  assert.match(out, /ghp_\[REDACTED\]/);
  assert.doesNotMatch(out, /abcdefghijkl/);
});

test("sanitizeString redacts github_pat_ tokens", () => {
  const out = sanitizeString("token: github_pat_ABCDEF1234567890_abcdef1234567890");
  assert.match(out, /github_pat_\[REDACTED\]/);
});

test("sanitizeString redacts x-access-token URLs", () => {
  const url = "https://x-access-token:ghs_secret123456789012345@github.com/owner/repo.git";
  const out = sanitizeString(url);
  assert.match(out, /x-access-token:\[REDACTED\]/);
  assert.doesNotMatch(out, /ghs_secret/);
});

test("sanitizeString redacts Bearer / token authorization values", () => {
  assert.match(sanitizeString("Authorization: Bearer abcdef0123456789xyzfoo"), /Bearer \[REDACTED\]/);
  assert.match(sanitizeString("token abcdef0123456789xyzfoo"), /token \[REDACTED\]/i);
});

test("sanitizeString leaves benign strings untouched", () => {
  assert.equal(sanitizeString("hello world"), "hello world");
  assert.equal(sanitizeString("status=ok count=12"), "status=ok count=12");
});

test("logger writes file and redacts tokens in serialized output", async () => {
  logger.info(
    { repo: "https://x-access-token:ghs_secret123456789012345@github.com/o/r.git" },
    "cloning",
  );
  logger.warn("Authorization: Bearer abcdef0123456789xyzfoo");

  const content = await flushAndRead(/\[REDACTED\]/);
  assert.match(content, /\[REDACTED\]/);
  assert.doesNotMatch(content, /ghs_secret/);
  assert.doesNotMatch(content, /abcdef0123456789xyzfoo/);
});

test("logger preserves Error details and handles circular records", async () => {
  const circular: Record<string, unknown> = { label: "cycle" };
  circular.self = circular;
  logger.error({ err: new Error("failed with ghp_abcdefghijklmnopqrstuvwxyz0123456789"), circular }, "boom");

  const content = await flushAndRead(/failed with ghp_\[REDACTED\]/);
  assert.match(content, /failed with ghp_\[REDACTED\]/);
  assert.match(content, /"self":"\[Circular\]"/);
  assert.doesNotMatch(content, /abcdefghijklmnopqrstuvwxyz0123456789/);
});

test("logger redacts printf-style interpolation arguments", async () => {
  logger.info("token is %s", "ghs_secret12345678901234567890");

  const content = await flushAndRead(/ghs_\[REDACTED\]/);
  assert.match(content, /ghs_\[REDACTED\]/);
  assert.doesNotMatch(content, /secret12345678901234567890/);
});

test("redact paths censor structured token fields", async () => {
  logger.info({ headers: { authorization: "Bearer ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" } }, "request");
  const content = await flushAndRead(/request/);
  // Either redact paths or sanitizeDeep should win — token must not appear.
  assert.doesNotMatch(content, /ghp_xxxxxxxxxx/);
});

test("logger handles circular structured fields", async () => {
  const circular: Record<string, unknown> = {
    repo: "https://x-access-token:ghs_secret123456789012345@github.com/o/r.git",
  };
  circular.self = circular;

  assert.doesNotThrow(() => logger.info(circular, "circular event"));

  const content = await flushAndRead(/"\[Circular\]"/);
  assert.match(content, /"\[Circular\]"/);
  assert.doesNotMatch(content, /ghs_secret/);
});

test("ring buffer captures entries", async () => {
  _resetRingBufferForTests();
  for (let i = 0; i < 5; i += 1) logger.info(`ring-msg-${i}`);
  await new Promise((r) => setTimeout(r, 30));
  const buf = readRingBuffer();
  assert.ok(buf.length >= 5);
  assert.match(buf.join("\n"), /ring-msg-0/);
  assert.match(buf.join("\n"), /ring-msg-4/);
});

test("ring buffer preserves records split across write chunks", async () => {
  _resetRingBufferForTests();
  const line = JSON.stringify({
    level: 30,
    time: 1710000000000,
    source: "split-test",
    msg: "split chunk event",
  });

  await _writeRingChunkForTests(line.slice(0, 20));
  assert.equal(readRingBuffer().length, 0);

  await _writeRingChunkForTests(`${line.slice(20)}   \n`);
  const buf = readRingBuffer();
  assert.equal(buf.length, 1);
  assert.match(buf[0], /split chunk event/);
});

test.after(() => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});
