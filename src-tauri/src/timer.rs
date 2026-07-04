use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Idle,
    Work,
    Break,
}

pub struct Timer {
    pub phase: Phase,
    pub remaining: u32,
    pub total: u32,
    pub running: bool,
    pub work_secs: u32,
    pub break_secs: u32,
}

impl Default for Timer {
    fn default() -> Self {
        Self {
            phase: Phase::Idle,
            remaining: 25 * 60,
            total: 25 * 60,
            running: false,
            work_secs: 25 * 60,
            break_secs: 5 * 60,
        }
    }
}

#[derive(Clone, Serialize)]
pub struct TimerSnapshot {
    pub phase: Phase,
    pub remaining: u32,
    pub total: u32,
    pub running: bool,
    pub work_secs: u32,
    pub break_secs: u32,
}

impl Timer {
    pub fn snapshot(&self) -> TimerSnapshot {
        TimerSnapshot {
            phase: self.phase,
            remaining: self.remaining,
            total: self.total,
            running: self.running,
            work_secs: self.work_secs,
            break_secs: self.break_secs,
        }
    }
}

pub type TimerState = Mutex<Timer>;

pub fn emit_state(app: &AppHandle) {
    let snap = app.state::<TimerState>().lock().unwrap().snapshot();
    let _ = app.emit("timer-state", snap);
}

pub fn spawn_tick_loop(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
        tick(&app);
    });
}

fn tick(app: &AppHandle) {
    let finished_phase = {
        let state = app.state::<TimerState>();
        let mut t = state.lock().unwrap();
        if !t.running || t.phase == Phase::Idle {
            return;
        }
        if t.remaining > 0 {
            t.remaining -= 1;
        }
        if t.remaining == 0 {
            Some(t.phase)
        } else {
            None
        }
    };

    match finished_phase {
        Some(Phase::Work) => start_break(app, None),
        Some(Phase::Break) => end_break(app),
        _ => emit_state(app),
    }
}

/// Transition into a break: capture the desktop first (the overlays must not
/// be on screen yet) for the instant frozen frame, then swallow every monitor
/// and start the live streams that replace it.
pub fn start_break(app: &AppHandle, secs_override: Option<u32>) {
    let display_ids = crate::capture::capture_all(app);
    {
        let state = app.state::<TimerState>();
        let mut t = state.lock().unwrap();
        t.phase = Phase::Break;
        t.total = secs_override.unwrap_or(t.break_secs);
        t.remaining = t.total;
        t.running = true;
    }
    crate::overlay::spawn_overlays(app);
    crate::live::start(app, display_ids);
    emit_state(app);
}

pub fn end_break(app: &AppHandle) {
    crate::live::stop(app);
    crate::overlay::close_overlays(app);
    {
        let state = app.state::<TimerState>();
        let mut t = state.lock().unwrap();
        t.phase = Phase::Work;
        t.total = t.work_secs;
        t.remaining = t.work_secs;
        t.running = true;
    }
    // The captured frames are ~30 MB per monitor; drop them once the hole is gone.
    crate::capture::clear(app);
    emit_state(app);
}
