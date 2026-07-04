import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Onboarding from "./Onboarding";
import "./App.css";

interface Snap {
  phase: "idle" | "work" | "break";
  remaining: number;
  total: number;
  running: boolean;
  work_secs: number;
  break_secs: number;
}

interface Config {
  onboarded: boolean;
  work_min: number;
  break_min: number;
  blocker_enabled: boolean;
  blocked_sites: string[];
  blocked_apps: string[];
}

const PHASE_LABEL: Record<Snap["phase"], string> = {
  idle: "ready",
  work: "focus",
  break: "event horizon",
};

function fmt(s: number): string {
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function App() {
  const [snap, setSnap] = useState<Snap | null>(null);
  const [workMin, setWorkMin] = useState(25);
  const [breakMin, setBreakMin] = useState(5);
  // null = still loading; false = show onboarding; true = show timer.
  const [onboarded, setOnboarded] = useState<boolean | null>(null);

  useEffect(() => {
    // Browser demo mode (no Tauri IPC): show onboarding with defaults so the
    // wizard and timer UI can be iterated on with `npm run dev`, mirroring the
    // overlay's demo fallback.
    if (!("__TAURI_INTERNALS__" in window)) {
      setOnboarded(false);
      return;
    }
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await listen<Snap>("timer-state", (e) => setSnap(e.payload));
      const cfg = await invoke<Config>("get_config");
      setOnboarded(cfg.onboarded);
      const s = await invoke<Snap>("get_state");
      setSnap(s);
      setWorkMin(Math.round(s.work_secs / 60));
      setBreakMin(Math.round(s.break_secs / 60));
    })();
    return () => unlisten?.();
  }, []);

  if (onboarded === null) return null; // brief config load
  if (!onboarded) {
    return (
      <Onboarding
        workMin={workMin}
        breakMin={breakMin}
        onDone={() => {
          void (async () => {
            const s = await invoke<Snap>("get_state");
            setSnap(s);
            setWorkMin(Math.round(s.work_secs / 60));
            setBreakMin(Math.round(s.break_secs / 60));
            setOnboarded(true);
          })();
        }}
      />
    );
  }

  const applyDurations = (w: number, b: number) => {
    void invoke("set_durations", { workMin: w, breakMin: b });
  };

  const phase = snap?.phase ?? "idle";
  const progress = snap && snap.total > 0 ? 1 - snap.remaining / snap.total : 0;

  return (
    <main className={`app phase-${phase}`}>
      <header>
        <h1>holedeep</h1>
        <p className="tagline">focus, or be devoured</p>
      </header>

      <section className="dial">
        <svg viewBox="0 0 200 200" className="ring">
          <circle cx="100" cy="100" r="88" className="ring-bg" />
          <circle
            cx="100"
            cy="100"
            r="88"
            className="ring-fg"
            strokeDasharray={`${progress * 2 * Math.PI * 88} ${2 * Math.PI * 88}`}
            transform="rotate(-90 100 100)"
          />
        </svg>
        <div className="dial-center">
          <div className="time">{fmt(snap?.remaining ?? workMin * 60)}</div>
          <div className="phase">{PHASE_LABEL[phase]}</div>
        </div>
      </section>

      <section className="controls">
        {snap?.running ? (
          <button onClick={() => void invoke("pause_timer")}>pause</button>
        ) : (
          <button className="primary" onClick={() => void invoke("start_timer")}>
            {phase === "idle" ? "start focus" : "resume"}
          </button>
        )}
        <button onClick={() => void invoke("reset_timer")}>reset</button>
      </section>

      <section className="settings">
        <label>
          focus
          <input
            type="number"
            min={1}
            max={180}
            value={workMin}
            onChange={(e) => {
              const v = Number(e.target.value) || 1;
              setWorkMin(v);
              applyDurations(v, breakMin);
            }}
          />
          min
        </label>
        <label>
          break
          <input
            type="number"
            min={1}
            max={60}
            value={breakMin}
            onChange={(e) => {
              const v = Number(e.target.value) || 1;
              setBreakMin(v);
              applyDurations(workMin, v);
            }}
          />
          min
        </label>
      </section>

      <footer>
        <button className="ghost" onClick={() => void invoke("test_break", { secs: 20 })}>
          ☄ preview the black hole (20s)
        </button>
        <button className="ghost" onClick={() => setOnboarded(false)}>
          ⚙ setup &amp; permissions
        </button>
      </footer>
    </main>
  );
}

export default App;
