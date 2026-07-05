//! Work-time distraction blocking — the focus-side counterpart to the
//! break-side black hole.
//!
//! Two hard blocks, active only while the timer is in the Work phase:
//!   * **Sites** — a fenced region in `/etc/hosts` points blocked domains at
//!     `0.0.0.0`. Editing `/etc/hosts` needs root, so the write goes through a
//!     single `osascript ... with administrator privileges` prompt (which also
//!     flushes DNS). We diff first and only prompt when the file actually needs
//!     changing, so toggling with nothing to do is silent.
//!   * **Apps** — a poll thread reads `NSWorkspace.runningApplications` and
//!     terminates any whose bundle id is on the blocklist. Reading the list and
//!     terminating same-user apps need no extra macOS permission.

use crate::config::ConfigState;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
use objc2_app_kit::{NSApplicationActivationPolicy, NSWorkspace};

/// Managed state: the app-watch poll thread's kill switch and the blocklist it
/// reads each tick (so re-activating with a new list needs no respawn).
#[derive(Default)]
pub struct Blocker {
    running: Arc<AtomicBool>,
    apps: Arc<Mutex<Vec<String>>>,
}

// --- /etc/hosts site blocking -------------------------------------------------

const HOSTS_PATH: &str = "/etc/hosts";
const MARK_START: &str = "# holedeep-start";
const MARK_END: &str = "# holedeep-end";

fn read_hosts() -> String {
    std::fs::read_to_string(HOSTS_PATH).unwrap_or_default()
}

/// Return `hosts` with any existing holedeep fenced region removed.
fn strip_block(hosts: &str) -> String {
    let mut out = String::new();
    let mut skipping = false;
    for line in hosts.lines() {
        match line.trim() {
            MARK_START => skipping = true,
            MARK_END => skipping = false,
            _ if !skipping => {
                out.push_str(line);
                out.push('\n');
            }
            _ => {}
        }
    }
    out
}

/// Write `content` to `/etc/hosts` via a single admin prompt, flushing DNS in
/// the same elevated shell so the block takes effect immediately.
fn write_hosts_admin(content: &str) {
    let tmp = std::env::temp_dir().join("holedeep_hosts.tmp");
    if std::fs::write(&tmp, content).is_err() {
        eprintln!("holedeep: could not stage hosts file");
        return;
    }
    let inner = format!(
        "cp '{}' {} && dscacheutil -flushcache; killall -HUP mDNSResponder || true",
        tmp.display(),
        HOSTS_PATH
    );
    let script = format!("do shell script \"{inner}\" with administrator privileges");
    let status = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .status();
    if let Err(e) = status {
        eprintln!("holedeep: hosts admin write failed: {e}");
    }
    let _ = std::fs::remove_file(&tmp);
}

fn apply_hosts_block(sites: &[String]) {
    let current = read_hosts();
    let base = strip_block(&current);
    let mut block = String::from(MARK_START);
    block.push('\n');
    for s in sites {
        let d = s.trim().trim_start_matches("www.");
        if d.is_empty() {
            continue;
        }
        block.push_str(&format!("0.0.0.0 {d}\n0.0.0.0 www.{d}\n"));
    }
    block.push_str(MARK_END);

    let mut desired = base.trim_end().to_string();
    desired.push('\n');
    desired.push_str(&block);
    desired.push('\n');

    if desired != current {
        write_hosts_admin(&desired);
    }
}

/// Remove the fenced region. No-op (and no admin prompt) if it isn't present.
fn remove_hosts_block() {
    let current = read_hosts();
    if !current.contains(MARK_START) {
        return;
    }
    let mut desired = strip_block(&current).trim_end().to_string();
    desired.push('\n');
    if desired != current {
        write_hosts_admin(&desired);
    }
}

// --- App blocking (NSWorkspace) ----------------------------------------------

#[cfg(target_os = "macos")]
fn terminate_blocked(blocked: &[String]) {
    if blocked.is_empty() {
        return;
    }
    let ws = NSWorkspace::sharedWorkspace();
    let apps = ws.runningApplications();
    for i in 0..apps.count() {
        let a = apps.objectAtIndex(i);
        if let Some(bid) = a.bundleIdentifier() {
            let bid = bid.to_string();
            if blocked.iter().any(|b| b.eq_ignore_ascii_case(&bid)) {
                a.terminate();
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn terminate_blocked(_blocked: &[String]) {}

fn start_app_watch(app: &AppHandle, blocked: Vec<String>) {
    let b = app.state::<Blocker>();
    *b.apps.lock().unwrap() = blocked;
    // swap returns the previous value; if it was already running, the live
    // thread will pick up the new list on its next tick — don't spawn a second.
    if b.running.swap(true, Ordering::SeqCst) {
        return;
    }
    let running = b.running.clone();
    let apps = b.apps.clone();
    std::thread::spawn(move || {
        while running.load(Ordering::SeqCst) {
            let list = apps.lock().unwrap().clone();
            terminate_blocked(&list);
            std::thread::sleep(Duration::from_millis(1000));
        }
    });
}

fn stop_app_watch(app: &AppHandle) {
    app.state::<Blocker>()
        .running
        .store(false, Ordering::SeqCst);
}

// --- Public lifecycle --------------------------------------------------------

/// Engage blocking for a focus session. No-op when the blocker is disabled.
pub fn activate(app: &AppHandle) {
    let cfg = app.state::<ConfigState>().0.lock().unwrap().clone();
    if !cfg.blocker_enabled {
        return;
    }
    if !cfg.blocked_sites.is_empty() {
        apply_hosts_block(&cfg.blocked_sites);
    }
    start_app_watch(app, cfg.blocked_apps);
}

/// Lift all blocking. Always safe to call — hosts cleanup is idempotent and the
/// app watch simply stops. Called on break/idle, reset, and app exit.
pub fn deactivate(app: &AppHandle) {
    stop_app_watch(app);
    remove_hosts_block();
}

// --- Commands ----------------------------------------------------------------

#[derive(Serialize)]
pub struct AppInfo {
    pub name: String,
    pub bundle_id: String,
}

/// List regular (Dock-visible) running apps so the UI can offer real bundle ids
/// to pick from instead of making the user type them.
#[tauri::command]
pub fn list_running_apps() -> Vec<AppInfo> {
    #[cfg(target_os = "macos")]
    {
        use std::collections::HashSet;
        let ws = NSWorkspace::sharedWorkspace();
        let apps = ws.runningApplications();
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for i in 0..apps.count() {
            let a = apps.objectAtIndex(i);
            if a.activationPolicy() != NSApplicationActivationPolicy::Regular {
                continue;
            }
            let Some(bid) = a.bundleIdentifier() else {
                continue;
            };
            let bundle_id = bid.to_string();
            if !seen.insert(bundle_id.clone()) {
                continue;
            }
            let name = a
                .localizedName()
                .map(|n| n.to_string())
                .unwrap_or_else(|| bundle_id.clone());
            out.push(AppInfo { name, bundle_id });
        }
        out.sort_by_key(|a| a.name.to_lowercase());
        out
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}
