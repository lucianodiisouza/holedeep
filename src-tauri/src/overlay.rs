use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

/// Overlay window title — also used to exclude the overlays from live screen
/// capture, so keep it in sync with anything that matches on it.
pub const OVERLAY_TITLE: &str = "holedeep break";

/// One borderless, always-on-top overlay per monitor. Windows are created on
/// the main thread (a macOS requirement) and paired with screenshots by the
/// same sorted-by-position index used in capture_all.
pub fn spawn_overlays(app: &AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let mut monitors = app.available_monitors().unwrap_or_default();
        monitors.sort_by_key(|m| (m.position().x, m.position().y));
        for (i, m) in monitors.iter().enumerate() {
            let label = format!("overlay-{i}");
            if app.get_webview_window(&label).is_some() {
                continue;
            }
            let url = WebviewUrl::App(format!("overlay.html?monitor={i}").into());
            let built = WebviewWindowBuilder::new(&app, &label, url)
                .title(OVERLAY_TITLE)
                .decorations(false)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .always_on_top(true)
                .visible_on_all_workspaces(true)
                .skip_taskbar(true)
                .shadow(false)
                .visible(false)
                .build();
            let Ok(win) = built else {
                eprintln!("spaghettify: failed to create {label}");
                continue;
            };
            let _ = win.set_position(PhysicalPosition::new(m.position().x, m.position().y));
            let _ = win.set_size(PhysicalSize::new(m.size().width, m.size().height));
            #[cfg(target_os = "macos")]
            cover_shell(&win);
            let _ = win.show();
            let _ = win.set_focus();
        }
    });
}

/// Lift an overlay above the macOS menu bar and Dock so the hole covers the
/// whole screen. `always_on_top` only reaches NSFloatingWindowLevel (3), which
/// the menu bar (24) and Dock (20) render on top of — leaving the real shell
/// visible next to the copy baked into the captured frame (the "double dock"
/// artifact). CGShieldingWindowLevel is the level screen savers use to sit over
/// everything; the collection behavior keeps the window put across Spaces and
/// alongside full-screen apps.
#[cfg(target_os = "macos")]
fn cover_shell(win: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};

    extern "C" {
        fn CGShieldingWindowLevel() -> i32;
    }

    let Ok(ptr) = win.ns_window() else {
        return;
    };
    let ns = ptr as *const NSWindow;
    unsafe {
        (*ns).setLevel(CGShieldingWindowLevel() as isize);
        (*ns).setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Stationary,
        );
    }
}

pub fn close_overlays(app: &AppHandle) {
    for (label, win) in app.webview_windows() {
        if label.starts_with("overlay-") {
            let _ = win.close();
        }
    }
}
