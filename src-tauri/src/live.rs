use crate::overlay::OVERLAY_TITLE;
use scap::capturer::{Capturer, Options, Resolution};
use scap::frame::{Frame, FrameType};
use scap::Target;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Latest live frame for one monitor. BGRA, 1080p-class — the shader swizzles
/// channels and the gravitational warp hides the downscale.
pub struct LiveFrame {
    pub seq: u32,
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
}

type Slot = Arc<Mutex<Option<LiveFrame>>>;

#[derive(Default)]
pub struct Live {
    slots: Mutex<Vec<Slot>>,
    running: Arc<AtomicBool>,
}

/// Start one ScreenCaptureKit stream per monitor. `display_ids` are
/// CGDirectDisplayIDs in the same sorted-by-position order as the screenshots
/// and overlay windows, so `index` means the same thing everywhere.
pub fn start(app: &AppHandle, display_ids: Vec<u32>) {
    let live = app.state::<Live>();
    live.running.store(true, Ordering::SeqCst);
    let slots: Vec<Slot> = display_ids.iter().map(|_| Slot::default()).collect();
    *live.slots.lock().unwrap() = slots.clone();
    for (i, id) in display_ids.into_iter().enumerate() {
        let slot = slots[i].clone();
        let running = live.running.clone();
        std::thread::spawn(move || run_capture(id, slot, running));
    }
}

pub fn stop(app: &AppHandle) {
    let live = app.state::<Live>();
    live.running.store(false, Ordering::SeqCst);
    live.slots.lock().unwrap().clear();
}

fn run_capture(display_id: u32, slot: Slot, running: Arc<AtomicBool>) {
    // let the overlay windows register with the window server before we
    // enumerate targets, or they won't be there to exclude
    std::thread::sleep(Duration::from_millis(400));

    let targets = scap::get_all_targets();
    let display = targets
        .iter()
        .find(|t| matches!(t, Target::Display(d) if d.id == display_id))
        .cloned();
    let Some(target) = display else {
        eprintln!("holedeep: live capture found no display {display_id}");
        return;
    };
    // exclude our own overlays — otherwise the hole would capture itself
    let excluded: Vec<Target> = targets
        .iter()
        .filter(|t| matches!(t, Target::Window(w) if w.title == OVERLAY_TITLE))
        .cloned()
        .collect();

    let options = Options {
        fps: 15,
        show_cursor: true,
        show_highlight: false,
        target: Some(target),
        crop_area: None,
        output_type: FrameType::BGRAFrame,
        output_resolution: Resolution::_1080p,
        excluded_targets: Some(excluded),
    };
    let mut capturer = match Capturer::build(options) {
        Ok(c) => c,
        Err(e) => {
            // no permission or unsupported: the overlay keeps the frozen shot
            eprintln!("holedeep: live capture unavailable: {e}");
            return;
        }
    };
    capturer.start_capture();

    let mut seq: u32 = 0;
    while running.load(Ordering::SeqCst) {
        match capturer.get_next_frame() {
            Ok(Frame::BGRA(f)) if f.width > 0 && f.height > 0 => {
                seq = seq.wrapping_add(1).max(1);
                *slot.lock().unwrap() = Some(LiveFrame {
                    seq,
                    width: f.width as u32,
                    height: f.height as u32,
                    bgra: f.data,
                });
            }
            Ok(_) => {}
            Err(_) => break, // stream ended
        }
    }
    capturer.stop_capture();
}

/// Poll the latest live frame. Raw IPC response: 16-byte header
/// (width, height, seq, format — all u32 LE, format 1 = BGRA) + pixels.
/// An empty body means "nothing newer than `since`" — the overlay keeps
/// whatever it is showing.
#[tauri::command]
pub fn get_frame(
    index: usize,
    since: u32,
    live: tauri::State<'_, Live>,
) -> Result<tauri::ipc::Response, String> {
    let slots = live.slots.lock().unwrap();
    let slot = slots
        .get(index)
        .ok_or_else(|| format!("no live capture for monitor {index}"))?;
    let guard = slot.lock().unwrap();
    match guard.as_ref() {
        Some(f) if f.seq != since => {
            let mut buf = Vec::with_capacity(16 + f.bgra.len());
            buf.extend_from_slice(&f.width.to_le_bytes());
            buf.extend_from_slice(&f.height.to_le_bytes());
            buf.extend_from_slice(&f.seq.to_le_bytes());
            buf.extend_from_slice(&1u32.to_le_bytes());
            buf.extend_from_slice(&f.bgra);
            Ok(tauri::ipc::Response::new(buf))
        }
        _ => Ok(tauri::ipc::Response::new(Vec::new())),
    }
}
