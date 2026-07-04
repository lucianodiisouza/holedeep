//! macOS Screen Recording permission plumbing for onboarding.
//!
//! Screen Recording is the make-or-break permission: without it the break
//! overlay captures nothing and the black hole renders over empty space
//! (`capture.rs`). We check it with the CoreGraphics preflight call (no prompt)
//! and can trigger the one-time system prompt on request. The grant only takes
//! effect after a relaunch, so onboarding offers a restart once granted.

use tauri::AppHandle;

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// Whether Screen Recording is currently granted. Non-macOS builds report
/// `true` (the app is macOS-only, but this keeps `cargo` green elsewhere).
#[tauri::command]
pub fn check_screen_permission() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        CGPreflightScreenCaptureAccess()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Trigger the macOS Screen Recording prompt (only shown once by the OS; after
/// that the user must toggle it in System Settings). Returns the resulting
/// grant state.
#[tauri::command]
pub fn request_screen_permission() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        CGRequestScreenCaptureAccess()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Open System Settings directly at Privacy → Screen Recording.
#[tauri::command]
pub fn open_screen_settings() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .spawn();
    }
}

/// Relaunch the app so a freshly granted Screen Recording permission takes
/// effect.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
}
