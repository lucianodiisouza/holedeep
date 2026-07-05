mod blocker;
mod capture;
mod config;
mod live;
mod overlay;
mod permissions;
mod timer;

use blocker::Blocker;
use config::{Config, ConfigState};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};
use timer::{Phase, Timer, TimerSnapshot, TimerState};

#[tauri::command]
fn get_state(state: tauri::State<'_, TimerState>) -> TimerSnapshot {
    state.lock().unwrap().snapshot()
}

#[tauri::command]
fn start_timer(app: AppHandle) {
    let entered_work = {
        let state = app.state::<TimerState>();
        let mut t = state.lock().unwrap();
        let entered_work = t.phase == Phase::Idle;
        if entered_work {
            t.phase = Phase::Work;
            t.total = t.work_secs;
            t.remaining = t.work_secs;
        }
        t.running = true;
        entered_work
    };
    if entered_work {
        blocker::activate(&app);
    }
    timer::emit_state(&app);
}

#[tauri::command]
fn pause_timer(app: AppHandle) {
    {
        let state = app.state::<TimerState>();
        state.lock().unwrap().running = false;
    }
    timer::emit_state(&app);
}

#[tauri::command]
fn reset_timer(app: AppHandle) {
    live::stop(&app);
    overlay::close_overlays(&app);
    capture::clear(&app);
    blocker::deactivate(&app);
    {
        let state = app.state::<TimerState>();
        let mut t = state.lock().unwrap();
        t.phase = Phase::Idle;
        t.total = t.work_secs;
        t.remaining = t.work_secs;
        t.running = false;
    }
    timer::emit_state(&app);
}

#[tauri::command]
fn skip_break(app: AppHandle) {
    let in_break = app.state::<TimerState>().lock().unwrap().phase == Phase::Break;
    if in_break {
        timer::end_break(&app);
    }
}

#[tauri::command]
fn set_durations(app: AppHandle, work_min: u32, break_min: u32) {
    let work_min = work_min.clamp(1, 180);
    let break_min = break_min.clamp(1, 60);
    {
        let state = app.state::<TimerState>();
        let mut t = state.lock().unwrap();
        t.work_secs = work_min * 60;
        t.break_secs = break_min * 60;
        if t.phase == Phase::Idle {
            t.total = t.work_secs;
            t.remaining = t.work_secs;
        }
    }
    config::update(&app, |c| {
        c.work_min = work_min;
        c.break_min = break_min;
    });
    timer::emit_state(&app);
}

#[tauri::command]
fn get_config(state: tauri::State<'_, ConfigState>) -> Config {
    state.0.lock().unwrap().clone()
}

/// Mark first-run onboarding complete so the app opens straight into the timer.
#[tauri::command]
fn complete_onboarding(app: AppHandle) {
    config::update(&app, |c| c.onboarded = true);
}

/// Persist the distraction-blocker settings. If we're mid-focus, re-apply so
/// the change (e.g. toggling off, or editing lists) takes effect immediately.
#[tauri::command]
fn set_blocker_config(app: AppHandle, enabled: bool, sites: Vec<String>, apps: Vec<String>) {
    config::update(&app, |c| {
        c.blocker_enabled = enabled;
        c.blocked_sites = sites;
        c.blocked_apps = apps;
    });
    let in_work = app.state::<TimerState>().lock().unwrap().phase == Phase::Work;
    if in_work {
        blocker::deactivate(&app);
        blocker::activate(&app);
    }
}

/// Dev/demo helper: jump straight into a short break to admire the hole.
#[tauri::command]
fn test_break(app: AppHandle, secs: Option<u32>) {
    timer::start_break(&app, Some(secs.unwrap_or(20).clamp(5, 600)));
}

fn toggle_running(app: &AppHandle) {
    let should_start = {
        let state = app.state::<TimerState>();
        let t = state.lock().unwrap();
        !t.running
    };
    if should_start {
        start_timer(app.clone());
    } else {
        pause_timer(app.clone());
    }
}

fn skip_phase(app: &AppHandle) {
    let phase = app.state::<TimerState>().lock().unwrap().phase;
    match phase {
        Phase::Break => timer::end_break(app),
        Phase::Work => timer::start_break(app, None),
        Phase::Idle => {}
    }
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Timer", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Start / Pause", true, None::<&str>)?;
    let skip = MenuItem::with_id(app, "skip", "Skip Phase", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &toggle, &skip, &quit])?;
    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "toggle" => toggle_running(app),
            "skip" => skip_phase(app),
            "quit" => {
                // Don't leave a hosts block or app-watch behind after we exit.
                blocker::deactivate(app);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_state,
            start_timer,
            pause_timer,
            reset_timer,
            skip_break,
            set_durations,
            test_break,
            get_config,
            complete_onboarding,
            set_blocker_config,
            blocker::list_running_apps,
            permissions::check_screen_permission,
            permissions::request_screen_permission,
            permissions::open_screen_settings,
            permissions::restart_app,
            capture::get_screenshot,
            live::get_frame
        ])
        .setup(|app| {
            let cfg = config::load(app.handle());
            let mut timer = Timer::default();
            timer.work_secs = cfg.work_min.clamp(1, 180) * 60;
            timer.break_secs = cfg.break_min.clamp(1, 60) * 60;
            timer.total = timer.work_secs;
            timer.remaining = timer.work_secs;
            app.manage(ConfigState(std::sync::Mutex::new(cfg)));
            app.manage(TimerState::new(timer));
            app.manage(capture::Shots::default());
            app.manage(live::Live::default());
            app.manage(Blocker::default());
            // Clear any hosts block left behind by a previous crash. Idempotent
            // and silent (no admin prompt) when there's nothing to remove.
            blocker::deactivate(app.handle());
            setup_tray(app)?;
            timer::spawn_tick_loop(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the timer window hides it; the app lives in the tray.
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
