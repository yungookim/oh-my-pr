import assert from "node:assert/strict";
import test from "node:test";
import { getTauriExternalLinkHref, handleTauriExternalLinkClick } from "./tauri";

function createClickEvent() {
  let prevented = false;

  return {
    event: {
      button: 0,
      defaultPrevented: false,
      target: null,
      preventDefault() {
        prevented = true;
      },
    },
    get prevented() {
      return prevented;
    },
  };
}

test("getTauriExternalLinkHref returns external browser-safe URLs", () => {
  assert.equal(
    getTauriExternalLinkHref(
      "https://github.com/yungookim/oh-my-pr/pull/1",
      "http://localhost:5001/#/",
    ),
    "https://github.com/yungookim/oh-my-pr/pull/1",
  );
  assert.equal(
    getTauriExternalLinkHref("mailto:maintainer@example.com", "http://localhost:5001/#/"),
    "mailto:maintainer@example.com",
  );
});

test("getTauriExternalLinkHref ignores same-origin app links", () => {
  assert.equal(getTauriExternalLinkHref("/settings", "http://localhost:5001/#/"), null);
  assert.equal(getTauriExternalLinkHref("http://localhost:5001/#/logs", "http://localhost:5001/#/"), null);
});

test("handleTauriExternalLinkClick opens external links through the provided opener", () => {
  const click = createClickEvent();
  const opened: string[] = [];

  const handled = handleTauriExternalLinkClick(
    click.event,
    (href) => {
      opened.push(href);
    },
    {
      currentHref: "http://localhost:5001/#/",
      findAnchor: () => ({
        href: "https://github.com/yungookim/oh-my-pr/pull/1",
        hasAttribute: () => false,
      }),
    },
  );

  assert.equal(handled, true);
  assert.equal(click.prevented, true);
  assert.deepEqual(opened, ["https://github.com/yungookim/oh-my-pr/pull/1"]);
});

test("handleTauriExternalLinkClick logs rejected external open attempts", async (t) => {
  const click = createClickEvent();
  const warnings: unknown[][] = [];
  const error = new Error("shell open failed");
  const originalWarn = console.warn;
  t.after(() => {
    console.warn = originalWarn;
  });
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  const handled = handleTauriExternalLinkClick(
    click.event,
    () => Promise.reject(error),
    {
      currentHref: "http://localhost:5001/#/",
      findAnchor: () => ({
        href: "https://github.com/yungookim/oh-my-pr/pull/1",
        hasAttribute: () => false,
      }),
    },
  );
  await Promise.resolve();

  assert.equal(handled, true);
  assert.equal(click.prevented, true);
  assert.deepEqual(warnings, [["Failed to open external link in Tauri", error]]);
});

test("handleTauriExternalLinkClick leaves internal links alone", () => {
  const click = createClickEvent();
  const opened: string[] = [];

  const handled = handleTauriExternalLinkClick(
    click.event,
    (href) => {
      opened.push(href);
    },
    {
      currentHref: "http://localhost:5001/#/",
      findAnchor: () => ({
        href: "http://localhost:5001/#/settings",
        hasAttribute: () => false,
      }),
    },
  );

  assert.equal(handled, false);
  assert.equal(click.prevented, false);
  assert.deepEqual(opened, []);
});
