import { createRenderer } from "./renderer";
import { makeFakeDesktop } from "./fakeDesktop";

// Intensity envelope: brief unwarped beat (sells the frozen-screen illusion),
// then the hole grows in, menaces, and collapses as the break runs out.
const APPEAR_DELAY = 0.8;
const GROW_SEC = 9;
const COLLAPSE_SEC = 4;
const HOLE_RADIUS = 0.12; // shadow radius at full size, fraction of screen height
const ESC_HOLD_SEC = 2.5;

const canvas = document.getElementById("glcanvas") as HTMLCanvasElement;
const countdownEl = document.getElementById("countdown")!;
const hintEl = document.getElementById("hint")!;
const skipFillEl = document.getElementById("skipfill") as HTMLElement;

const renderer = createRenderer(canvas);
const isTauri = "__TAURI_INTERNALS__" in window;

// break clock, updated from timer-state events (or faked in demo mode)
let total = 300;
let remaining = 300;
let lastEventAt = performance.now();
let skipBreak: () => void = () => {};

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(Math.round(s) % 60).padStart(2, "0")}`;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function intensityNow(): number {
  const sinceEvent = (performance.now() - lastEventAt) / 1000;
  const elapsed = total - remaining + sinceEvent;
  const remF = Math.max(0, remaining - sinceEvent);
  return smoothstep(APPEAR_DELAY, APPEAR_DELAY + GROW_SEC, elapsed) * smoothstep(0, COLLAPSE_SEC, remF);
}

// ---- Esc-hold escape hatch: never truly lock someone out of their machine
let escDownAt: number | null = null;
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !e.repeat) escDownAt = performance.now();
});
window.addEventListener("keyup", (e) => {
  if (e.key === "Escape") escDownAt = null;
});
window.addEventListener("blur", () => (escDownAt = null));

const start = performance.now();
function frame() {
  const now = performance.now();

  const held = escDownAt ? (now - escDownAt) / 1000 : 0;
  skipFillEl.style.width = `${Math.min(100, (held / ESC_HOLD_SEC) * 100)}%`;
  if (held >= ESC_HOLD_SEC) {
    escDownAt = null;
    skipBreak();
  }

  countdownEl.textContent = fmt(Math.max(0, remaining - (now - lastEventAt) / 1000));
  renderer.render((now - start) / 1000, intensityNow(), HOLE_RADIUS);
  requestAnimationFrame(frame);
}

async function initTauri() {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  const monitor = Number(new URLSearchParams(location.search).get("monitor") ?? "0");
  skipBreak = () => void invoke("skip_break");

  interface Snap {
    phase: "idle" | "work" | "break";
    remaining: number;
    total: number;
  }
  const apply = (s: Snap) => {
    if (s.phase !== "break") return; // Rust closes this window momentarily
    total = s.total;
    remaining = s.remaining;
    lastEventAt = performance.now();
  };
  await listen<Snap>("timer-state", (e) => apply(e.payload));
  apply(await invoke<Snap>("get_state"));

  try {
    const buf = await invoke<ArrayBuffer>("get_screenshot", { index: monitor });
    const dv = new DataView(buf);
    renderer.setScreen(dv.getUint32(0, true), dv.getUint32(4, true), new Uint8Array(buf, 8));
  } catch (err) {
    // no Screen Recording permission (or capture failed): deep-space fallback
    console.warn("screenshot unavailable, falling back to starfield:", err);
    renderer.setScreen(0, 0, null);
  }

  // Live frames replace the frozen shot as they arrive (~15 fps). Header:
  // width, height, seq, format (u32 LE); empty body = nothing newer.
  let seq = 0;
  let failures = 0;
  const pollFrames = async () => {
    while (failures < 10) {
      try {
        const buf = await invoke<ArrayBuffer>("get_frame", { index: monitor, since: seq });
        if (buf.byteLength > 16) {
          const dv = new DataView(buf);
          seq = dv.getUint32(8, true);
          renderer.setScreen(
            dv.getUint32(0, true),
            dv.getUint32(4, true),
            new Uint8Array(buf, 16),
            dv.getUint32(12, true) === 1,
          );
        }
        failures = 0;
      } catch {
        failures += 1; // live capture may be unavailable; keep the frozen shot
      }
      await new Promise((r) => setTimeout(r, 66));
    }
  };
  void pollFrames();
}

function initDemo() {
  // Browser demo: fake desktop, looping 30 s break
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(window.innerWidth * dpr);
  const h = Math.round(window.innerHeight * dpr);
  renderer.setScreen(w, h, makeFakeDesktop(w, h));

  total = 30;
  remaining = 30;
  lastEventAt = performance.now();
  hintEl.textContent = "demo mode — hold esc to restart the loop";
  const reset = () => {
    remaining = total;
    lastEventAt = performance.now();
  };
  skipBreak = reset;
  setInterval(() => {
    remaining = Math.max(0, remaining - 1);
    lastEventAt = performance.now();
    if (remaining === 0) setTimeout(reset, 1500);
  }, 1000);
}

if (isTauri) {
  void initTauri();
} else {
  initDemo();
}
requestAnimationFrame(frame);
