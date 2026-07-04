use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// One captured monitor. Shots are stored sorted by virtual-desktop position;
/// overlays are paired with them by the same sorted index.
pub struct Shot {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

#[derive(Default)]
pub struct Shots(pub Mutex<Vec<Shot>>);

/// Capture every monitor. On macOS this needs the Screen Recording permission;
/// without it we end up with zero shots and the overlay falls back to rendering
/// the hole over deep space instead of the desktop.
///
/// Returns the CGDirectDisplayIDs in sorted-by-position order — the shared
/// index space for shots, overlay windows, and live capture streams.
pub fn capture_all(app: &AppHandle) -> Vec<u32> {
    let mut shots = Vec::new();
    let mut display_ids = Vec::new();
    match xcap::Monitor::all() {
        Ok(monitors) => {
            let mut monitors = monitors;
            monitors.sort_by_key(|m| (m.x().unwrap_or(0), m.y().unwrap_or(0)));
            for m in monitors {
                match m.capture_image() {
                    Ok(img) => {
                        display_ids.push(m.id().unwrap_or(0));
                        shots.push(Shot {
                            width: img.width(),
                            height: img.height(),
                            rgba: img.into_raw(),
                        });
                    }
                    Err(e) => eprintln!("holedeep: monitor capture failed: {e}"),
                }
            }
        }
        Err(e) => eprintln!("holedeep: monitor enumeration failed: {e}"),
    }
    *app.state::<Shots>().0.lock().unwrap() = shots;
    display_ids
}

pub fn clear(app: &AppHandle) {
    app.state::<Shots>().0.lock().unwrap().clear();
}

/// Raw IPC response: 8-byte header (width, height as u32 LE) + RGBA pixels.
/// Raw bytes skip both PNG encode/decode and JSON serialization — a 5K Retina
/// frame moves in one memcpy-ish hop.
#[tauri::command]
pub fn get_screenshot(
    index: usize,
    shots: tauri::State<'_, Shots>,
) -> Result<tauri::ipc::Response, String> {
    let shots = shots.0.lock().unwrap();
    let s = shots
        .get(index)
        .ok_or_else(|| format!("no screenshot captured for monitor {index}"))?;
    let mut buf = Vec::with_capacity(8 + s.rgba.len());
    buf.extend_from_slice(&s.width.to_le_bytes());
    buf.extend_from_slice(&s.height.to_le_bytes());
    buf.extend_from_slice(&s.rgba);
    Ok(tauri::ipc::Response::new(buf))
}
