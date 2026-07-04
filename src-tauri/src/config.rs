use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// Persisted user configuration. This is the single source of truth for
/// durations and blocker settings; the in-memory `Timer` is seeded from it at
/// startup and `set_durations` writes back here.
#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Whether the first-run onboarding wizard has been completed.
    pub onboarded: bool,
    pub work_min: u32,
    pub break_min: u32,
    // Phase 2 — distraction blockers.
    pub blocker_enabled: bool,
    /// Bare domains, e.g. "reddit.com" (the `www.` variant is added at block time).
    pub blocked_sites: Vec<String>,
    /// macOS bundle identifiers, e.g. "com.tinyspeck.slackmacgap".
    pub blocked_apps: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            onboarded: false,
            work_min: 25,
            break_min: 5,
            blocker_enabled: false,
            blocked_sites: vec![
                "reddit.com".into(),
                "youtube.com".into(),
                "twitter.com".into(),
                "x.com".into(),
                "news.ycombinator.com".into(),
            ],
            blocked_apps: Vec::new(),
        }
    }
}

/// Managed wrapper so the config can live in Tauri state behind a mutex.
pub struct ConfigState(pub Mutex<Config>);

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join("config.json"))
}

/// Read config from disk, falling back to defaults if it is missing or corrupt.
pub fn load(app: &AppHandle) -> Config {
    let Some(path) = config_path(app) else {
        return Config::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            eprintln!("holedeep: config parse failed ({e}); using defaults");
            Config::default()
        }),
        Err(_) => Config::default(),
    }
}

/// Persist config to disk, creating the config directory if needed.
pub fn save(app: &AppHandle, cfg: &Config) {
    let Some(path) = config_path(app) else {
        eprintln!("holedeep: no config dir; not saving");
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match serde_json::to_string_pretty(cfg) {
        Ok(text) => {
            if let Err(e) = std::fs::write(&path, text) {
                eprintln!("holedeep: config write failed: {e}");
            }
        }
        Err(e) => eprintln!("holedeep: config serialize failed: {e}"),
    }
}

/// Convenience: mutate the managed config under its lock and persist the result.
pub fn update<F: FnOnce(&mut Config)>(app: &AppHandle, f: F) -> Config {
    let state = app.state::<ConfigState>();
    let mut cfg = state.0.lock().unwrap();
    f(&mut cfg);
    save(app, &cfg);
    cfg.clone()
}
