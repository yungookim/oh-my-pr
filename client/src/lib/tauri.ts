/**
 * Detect whether the app is running inside a Tauri webview.
 * Works in both Tauri v1 and v2.
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type ExternalLinkAnchor = {
  href: string;
  hasAttribute(name: string): boolean;
};

type ExternalLinkClickEvent = {
  button: number;
  defaultPrevented: boolean;
  target: EventTarget | null;
  preventDefault(): void;
};

type ExternalLinkHandlerOptions = {
  currentHref?: string;
  findAnchor?: (target: EventTarget | null) => ExternalLinkAnchor | null;
};

let removeExternalLinkHandler: (() => void) | null = null;

export function getTauriExternalLinkHref(href: string, currentHref: string): string | null {
  try {
    const url = new URL(href, currentHref);

    if (url.protocol === "mailto:" || url.protocol === "tel:") {
      return url.href;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    return url.origin === new URL(currentHref).origin ? null : url.href;
  } catch {
    return null;
  }
}

function findAnchorFromTarget(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof Element)) {
    return null;
  }

  return target.closest("a[href]");
}

async function openExternalHref(href: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("plugin:shell|open", { path: href });
}

export function handleTauriExternalLinkClick(
  event: ExternalLinkClickEvent,
  openExternal: (href: string) => void | Promise<void>,
  options: ExternalLinkHandlerOptions = {},
): boolean {
  if (event.defaultPrevented || event.button !== 0) {
    return false;
  }

  const anchor = (options.findAnchor ?? findAnchorFromTarget)(event.target);
  if (!anchor || anchor.hasAttribute("download")) {
    return false;
  }

  const currentHref = options.currentHref ?? window.location.href;
  const href = getTauriExternalLinkHref(anchor.href, currentHref);
  if (!href) {
    return false;
  }

  event.preventDefault();
  void Promise.resolve(openExternal(href)).catch((error: unknown) => {
    console.warn("Failed to open external link in Tauri", error);
  });
  return true;
}

export function installTauriExternalLinkHandler(): () => void {
  if (!isTauri() || typeof document === "undefined") {
    return () => {};
  }

  if (removeExternalLinkHandler) {
    return removeExternalLinkHandler;
  }

  const listener = (event: MouseEvent) => {
    handleTauriExternalLinkClick(event, openExternalHref);
  };

  document.addEventListener("click", listener, true);
  removeExternalLinkHandler = () => {
    document.removeEventListener("click", listener, true);
    removeExternalLinkHandler = null;
  };

  return removeExternalLinkHandler;
}
