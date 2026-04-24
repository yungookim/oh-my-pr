# Native App Framework Evaluation for oh-my-pr

## Context

oh-my-pr is currently a web application (React frontend + Express backend) that runs locally and opens in the user's browser. We want to convert it into a native desktop app with the following critical requirement:

- **Single-instance enforcement**: Only one instance of oh-my-pr may run on the OS at a time.

This document evaluates frameworks as alternatives to Electron.

---

## Framework Comparison

### 1. Tauri (Rust backend)

| Aspect | Details |
|--------|---------|
| **Single-instance support** | Built-in via [`tauri-plugin-single-instance`](https://v2.tauri.app/plugin/single-instance/) (latest v2.3.6). Must be registered as the first plugin. Uses DBus on Linux, platform-native mechanisms on Windows/macOS. Callback fires with CLI args and CWD when a second instance is attempted. Integrates with the deep-link plugin. Caveat: on Linux, extra config needed inside Snap/Flatpak sandboxes. |
| **Bundle size** | ~3-10 MB (vs. Electron's ~150+ MB). Uses the OS webview (WebView2 on Windows, WebKit on macOS/Linux) instead of bundling Chromium. |
| **Memory usage** | ~30-40 MB idle (vs. Electron's 200-300+ MB). No bundled V8 engine or Chromium. Startup under 500ms. |
| **Tech stack** | Rust for backend/system APIs, any web framework for frontend. Our existing React/Vite frontend can be reused with minimal changes. |
| **Frontend reuse** | Excellent. Tauri serves the web frontend in a webview. Our React + Tailwind + shadcn/ui frontend works as-is. |
| **System APIs** | File system, system tray, notifications, clipboard, dialogs, shell commands, auto-start, global shortcuts, deep linking, IPC (commands + events). |
| **Child process spawning** | Supported via `tauri-plugin-shell` (sidecar and command execution). Critical for oh-my-pr's `codex`/`claude` CLI agent spawning. |
| **Auto-update** | Built-in [`tauri-plugin-updater`](https://v2.tauri.app/plugin/updater/) with cryptographic signature verification, differential updates, and flexible restart strategies. |
| **Cross-platform** | Windows, macOS, Linux. Also supports iOS/Android (Tauri v2). |
| **Maturity** | Tauri v2 is stable (released 2024). Large community, active development, used in production by many projects. |
| **SQLite support** | `tauri-plugin-sql` or use the existing Node.js SQLite via a sidecar. Alternatively, can run the Express server as a sidecar process. |
| **Migration effort** | **Medium**. Frontend reusable. Backend needs adaptation: either port Express routes to Tauri commands (Rust), or run Express as a sidecar process and use the webview to connect to it. |

**Single-instance implementation:**
```rust
// In Cargo.toml
// tauri-plugin-single-instance = "2"

// In lib.rs
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            // Focus the main window when a second instance is attempted
            if let Some(window) = app.get_webview_window("main") {
                window.set_focus().unwrap();
            }
        }))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

---

### 2. Wails (Go backend)

| Aspect | Details |
|--------|---------|
| **Single-instance support** | Built-in via [`SingleInstanceLock`](https://wails.io/docs/guides/single-instance-lock/) in v2, and [enhanced in v3](https://v3alpha.wails.io/guides/single-instance/) with optional AES-256-GCM encryption for inter-instance communication. Uses mutex + window messages on Windows, flock + signals on Unix, DBus on Linux. Security note: Wails warns to treat data from second-instance callbacks as untrusted. |
| **Bundle size** | ~5-15 MB. Uses OS webview like Tauri. |
| **Memory usage** | ~60-100 MB. Similar to Tauri. |
| **Tech stack** | Go for backend, any web framework for frontend. |
| **Frontend reuse** | Excellent. Same webview approach. React frontend works directly. |
| **System APIs** | File system, system tray, menus, dialogs, clipboard, events. Slightly smaller API surface than Tauri. |
| **Child process spawning** | Native Go `os/exec` — trivial and robust. |
| **Auto-update** | Community solutions; no built-in updater as mature as Tauri's. |
| **Cross-platform** | Windows, macOS, Linux. |
| **Maturity** | Wails v2 is stable. Wails v3 is in active development. Smaller community than Tauri but growing. |
| **Migration effort** | **Medium-High**. Backend would need to be rewritten in Go. Frontend reusable. |

**Single-instance implementation:**
```go
app := wails.CreateApp(&wails.AppConfig{
    SingleInstanceLock: &options.SingleInstanceLock{
        UniqueId: "com.yungookim.ohmypr",
        OnSecondInstanceLaunch: func(data options.SecondInstanceData) {
            // Focus main window
            runtime.WindowUnminimise(ctx)
            runtime.Show(ctx)
        },
    },
})
```

---

### 3. Neutralinojs

| Aspect | Details |
|--------|---------|
| **Single-instance support** | **No built-in support.** [Open feature request (#901)](https://github.com/neutralinojs/neutralinojs/issues/901) filed May 2022, still unimplemented. `Neutralino.app.broadcast` can communicate between instances but does not prevent multiple from launching. Manual lock-file workaround required. **Blocker for our requirements.** |
| **Bundle size** | ~2-5 MB. Smallest of all options. |
| **Memory usage** | ~30-50 MB. Very lightweight. |
| **Tech stack** | C++ runtime, JavaScript/TypeScript for both backend and frontend. |
| **Frontend reuse** | Good. Web frontend works. |
| **System APIs** | File system, system tray, clipboard, OS info. More limited than Tauri/Wails. |
| **Child process spawning** | Supported via `Neutralino.os.execCommand()`. |
| **Auto-update** | Basic built-in updater (resource replacement only, not full binary updates). |
| **Cross-platform** | Windows, macOS, Linux, Web. |
| **Maturity** | **Low-medium.** Primarily maintained by a single developer. Not recommended for enterprise use. Limited ecosystem. |
| **Migration effort** | **Low** (since JS backend), but fragile for production use. |

---

### 4. Flutter Desktop

| Aspect | Details |
|--------|---------|
| **Single-instance support** | No built-in support ([Flutter issue #90889](https://github.com/flutter/flutter/issues/90889)). Fragmented community packages: [`windows_single_instance`](https://pub.dev/packages/windows_single_instance) (Windows only), [`flutter_alone`](https://pub.dev/packages/flutter_alone) (Windows + macOS). Linux requires modifying `my_application.cc` to remove `G_APPLICATION_NON_UNIQUE` flag. Reliable cross-platform single-instance requires combining multiple packages. |
| **Bundle size** | ~15-30 MB. Bundles the Skia rendering engine. |
| **Memory usage** | ~80-150 MB. Higher due to custom rendering. |
| **Tech stack** | Dart. **Cannot reuse the existing React frontend.** Full rewrite required. |
| **Frontend reuse** | **None.** Flutter uses its own widget system. The entire React/Tailwind/shadcn UI would need to be rebuilt in Dart/Flutter. |
| **System APIs** | File system, system tray (via plugins), notifications, platform channels for native code. |
| **Child process spawning** | Supported via `dart:io` `Process.run()`. |
| **Auto-update** | Community solutions. MSIX on Windows, DMG on macOS. |
| **Cross-platform** | Windows, macOS, Linux, iOS, Android, Web. Broadest reach. |
| **Maturity** | High. Backed by Google. Large ecosystem. |
| **Migration effort** | **Very High.** Complete frontend rewrite in Dart. No code reuse for UI. |

---

## Comparison Summary

| Feature | Tauri | Wails | Neutralinojs | Flutter |
|---------|-------|-------|--------------|---------|
| **Single-instance** | Built-in plugin | Built-in option | Manual only | Community package |
| **Bundle size** | ~3-10 MB | ~5-15 MB | ~2-5 MB | ~15-30 MB |
| **Memory** | ~30-40 MB | ~60-100 MB | ~30-50 MB | ~80-150 MB |
| **Frontend reuse** | Full | Full | Full | None |
| **System API breadth** | Excellent | Good | Limited | Good |
| **Child process spawn** | Plugin | Native Go | Supported | Supported |
| **Auto-update** | Built-in | Community | Basic | Community |
| **Maturity** | High | Medium | Low | High |
| **Backend language** | Rust | Go | JS | Dart |
| **Migration effort** | Medium | Medium-High | Low | Very High |

---

## Recommendation: Tauri

**Tauri is the clear winner for oh-my-pr** for the following reasons:

### 1. First-class single-instance support
The `tauri-plugin-single-instance` plugin provides exactly what we need with zero custom code — OS-level mutex enforcement with a callback to handle the second instance's arguments (e.g., to focus the existing window or handle deep links).

### 2. Full frontend reuse
Our React + Vite + Tailwind + shadcn/ui frontend works in Tauri's webview with minimal changes. The migration primarily affects the backend integration layer, not the UI.

### 3. Practical migration path for oh-my-pr
Two viable approaches:

- **Option A — Sidecar architecture** (recommended for faster migration): Run the existing Express server as a Tauri sidecar process. The webview connects to `localhost:5001` as it does today. Tauri provides the native shell (window management, system tray, single-instance, auto-update). This preserves the entire existing backend.

- **Option B — Full Tauri commands**: Port Express API routes to Tauri commands in Rust. More work upfront but tighter integration and better security (no open localhost port).

### 4. Production-ready features oh-my-pr needs
- **Shell command execution**: Critical for spawning `codex`/`claude` CLI agents — supported via `tauri-plugin-shell`.
- **File system access**: Critical for worktree management, SQLite database, logs — supported via `tauri-plugin-fs`.
- **System tray**: Run oh-my-pr in background while babysitting PRs.
- **Notifications**: Alert when PR feedback needs attention.
- **Auto-update**: Push updates to users seamlessly.

### 5. Small footprint
~3-10 MB bundle (vs. Electron's 150+ MB) means fast downloads and low disk usage. ~30-40 MB memory fits oh-my-pr's "runs in the background" use case.

---

## Why Not the Others?

| Framework | Reason to pass |
|-----------|---------------|
| **Wails** | Good option, but requires rewriting the backend in Go. Smaller ecosystem and less mature auto-update story. Single-instance is built-in though. Would be a reasonable second choice. |
| **Neutralinojs** | No built-in single-instance support. Single-maintainer project. Limited API surface. Not enterprise-ready. |
| **Flutter** | Requires complete frontend rewrite in Dart. No code reuse for our React UI. Overkill for a developer tool that already has a web frontend. |
| **Electron** | Works but bundles Chromium (~150 MB), high memory usage (~300 MB+). Single-instance is supported via `app.requestSingleInstanceLock()`. Only advantage is zero migration effort for a Node.js/web app. |

---

## Implementation Status

- [x] **Scaffold a Tauri v2 project** alongside the existing codebase (`src-tauri/`)
- [x] **Option A (sidecar)**: Express server runs as a child process; Tauri webview connects to `localhost:{port}`
- [x] **`tauri-plugin-single-instance`**: Enabled — second instance focuses the existing window
- [x] **Browser mode preserved**: `npm run dev` / `npm start` still works without Tauri
- [ ] **Add system tray** support for background operation
- [ ] **Add `tauri-plugin-updater`** for auto-updates
- [ ] **Incrementally migrate** Express routes to Tauri commands if desired

### Running

| Mode | Command | Description |
|------|---------|-------------|
| Browser (dev) | `npm run dev` | Express + Vite HMR, opens in browser |
| Browser (prod) | `npm run build && npm start` | Built app served by Express |
| Desktop (dev) | `npm run tauri:dev` | Tauri webview wrapping the dev server |
| Desktop (build) | `npm run tauri:build` | Produces native installer with bundled server |

---

## References

- [Tauri Single Instance Plugin](https://v2.tauri.app/plugin/single-instance/)
- [Tauri Plugin Updater](https://v2.tauri.app/plugin/updater/)
- [Tauri System Tray](https://v2.tauri.app/learn/system-tray/)
- [Tauri v2 Stable Release](https://v2.tauri.app/blog/tauri-20/)
- [Wails Single Instance Lock (v2)](https://wails.io/docs/guides/single-instance-lock/)
- [Wails Single Instance (v3)](https://v3alpha.wails.io/guides/single-instance/)
- [Neutralinojs Single Instance Feature Request (#901)](https://github.com/neutralinojs/neutralinojs/issues/901)
- [Flutter Issue #90889 — Prevent Multiple Instances](https://github.com/flutter/flutter/issues/90889)
- [Web-to-Desktop Framework Comparison](https://github.com/nicedoc/nicedoc.io/blob/master/README.md)
