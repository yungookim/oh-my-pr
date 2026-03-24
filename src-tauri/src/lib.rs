use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

struct ServerProcess(Mutex<Option<Child>>);

fn version_sort_key(path: &Path) -> Vec<u32> {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .trim_start_matches('v')
        .split('.')
        .filter_map(|part| part.parse::<u32>().ok())
        .collect()
}

fn node_binary_for_version(version_dir: &Path) -> Option<PathBuf> {
    [
        version_dir.join("bin").join("node"),
        version_dir.join("installation").join("bin").join("node"),
    ]
    .into_iter()
    .find(|path| path.exists())
}

/// Find the node binary by checking common install locations.
/// GUI apps on macOS don't inherit the shell PATH, so `node` alone won't resolve
/// for nvm, Homebrew, fnm, Volta, or other version managers.
fn find_node() -> Option<PathBuf> {
    // First, try the bare command (works if node is in the system PATH)
    if Command::new("node")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success())
    {
        return Some(PathBuf::from("node"));
    }

    let home = std::env::var("HOME").ok()?;
    let candidates = [
        // nvm (most common on macOS)
        format!("{}/.nvm/versions/node", home),
        // fnm
        format!("{}/.local/share/fnm/node-versions", home),
        format!("{}/Library/Application Support/fnm/node-versions", home),
        // Volta
        format!("{}/.volta/tools/image/node", home),
    ];

    for base in &candidates {
        let base_path = PathBuf::from(base);
        if !base_path.is_dir() {
            continue;
        }
        // Pick the highest semver directory
        if let Ok(entries) = std::fs::read_dir(&base_path) {
            let mut versions: Vec<PathBuf> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            versions.sort_by_key(|path| version_sort_key(path));
            if let Some(node_bin) = versions
                .iter()
                .rev()
                .find_map(|version| node_binary_for_version(version))
            {
                return Some(node_bin);
            }
        }
    }

    // Homebrew paths
    let brew_paths = [
        "/opt/homebrew/bin/node", // Apple Silicon
        "/usr/local/bin/node",    // Intel Mac / Linux Homebrew
    ];
    for path in &brew_paths {
        let p = PathBuf::from(path);
        if p.exists() {
            return Some(p);
        }
    }

    None
}

fn start_server(resource_dir: PathBuf, port: u16) -> Result<Child, String> {
    let server_script = resource_dir.join("dist").join("index.cjs");

    if !server_script.exists() {
        return Err(format!(
            "Server bundle not found at {}",
            server_script.display()
        ));
    }

    let node = find_node().ok_or_else(|| {
        "Node.js not found. Please install Node.js (https://nodejs.org) and restart the app."
            .to_string()
    })?;

    Command::new(&node)
        .arg(&server_script)
        .env("NODE_ENV", "production")
        .env("PORT", port.to_string())
        .current_dir(&resource_dir)
        .spawn()
        .map_err(|e| format!("Failed to start server with {}: {}", node.display(), e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let port: u16 = if cfg!(debug_assertions) {
        5001
    } else {
        portpicker::pick_unused_port().unwrap_or(5001)
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            if !cfg!(debug_assertions) {
                let resource_dir = app
                    .path()
                    .resource_dir()
                    .map_err(|e| format!("Failed to resolve resource directory: {}", e))?;

                match start_server(resource_dir, port) {
                    Ok(child) => {
                        app.manage(ServerProcess(Mutex::new(Some(child))));
                    }
                    Err(msg) => {
                        eprintln!("Server error: {}", msg);
                        // Show a native dialog so the user knows what went wrong
                        if let Some(window) = app.get_webview_window("main") {
                            window
                                .dialog()
                                .message(msg.clone())
                                .title("Code Factory — Error")
                                .kind(MessageDialogKind::Error)
                                .show(|_| {});
                        }
                        app.manage(ServerProcess(Mutex::new(None)));
                        return Err(msg.into());
                    }
                }

                // Give the server time to initialize
                std::thread::sleep(std::time::Duration::from_millis(2000));
            } else {
                app.manage(ServerProcess(Mutex::new(None)));
            }

            let server_url = format!("http://localhost:{}", port);
            if let Some(window) = app.get_webview_window("main") {
                let url: tauri::Url = server_url
                    .parse()
                    .map_err(|e| format!("Invalid URL: {}", e))?;
                let _ = window.navigate(url);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<ServerProcess>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(ref mut child) = *guard {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
