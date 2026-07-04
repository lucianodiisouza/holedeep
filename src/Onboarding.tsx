import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Onboarding.css";

interface Props {
  /** Initial durations from persisted config. */
  workMin: number;
  breakMin: number;
  /** Called once onboarding is finished; parent drops into the timer. */
  onDone: () => void;
}

type Step = "welcome" | "permission" | "durations";

export default function Onboarding({ workMin: w0, breakMin: b0, onDone }: Props) {
  const [step, setStep] = useState<Step>("welcome");
  const [granted, setGranted] = useState<boolean | null>(null);
  const [asked, setAsked] = useState(false);
  const [workMin, setWorkMin] = useState(w0);
  const [breakMin, setBreakMin] = useState(b0);

  // Poll the permission state while on the permission step so the UI reflects a
  // grant made in System Settings without a manual refresh.
  useEffect(() => {
    if (step !== "permission") return;
    let alive = true;
    const check = async () => {
      const ok = await invoke<boolean>("check_screen_permission");
      if (alive) setGranted(ok);
    };
    void check();
    const id = setInterval(check, 1500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [step]);

  const requestPermission = async () => {
    setAsked(true);
    const ok = await invoke<boolean>("request_screen_permission");
    setGranted(ok);
  };

  const finish = async () => {
    await invoke("set_durations", { workMin, breakMin });
    await invoke("complete_onboarding");
    onDone();
  };

  return (
    <main className="onboard">
      <header>
        <h1>holedeep</h1>
        <p className="tagline">focus, or be devoured</p>
      </header>

      {step === "welcome" && (
        <section className="card">
          <p className="lead">
            A pomodoro timer where your break is enforced by a black hole. When
            focus ends, it spawns over your live desktop and lenses your work
            into oblivion until the break is over.
          </p>
          <p className="note">
            Two quick steps: grant a permission, then pick your rhythm.
          </p>
          <div className="actions">
            <button className="primary" onClick={() => setStep("permission")}>
              begin
            </button>
          </div>
        </section>
      )}

      {step === "permission" && (
        <section className="card">
          <h2>screen recording</h2>
          <p className="lead">
            The black hole devours your <em>real</em> desktop, so holedeep needs
            macOS <strong>Screen Recording</strong> access. Without it, breaks
            render over empty space instead of your screen.
          </p>

          <div className={`status ${granted ? "ok" : "pending"}`}>
            {granted ? "✓ permission granted" : "○ not granted yet"}
          </div>

          {granted ? (
            <p className="note">
              You may need to <strong>restart</strong> holedeep for the grant to
              take effect before the first break.
            </p>
          ) : (
            <p className="note">
              {asked
                ? "If no prompt appeared, add holedeep under Privacy → Screen Recording, then return here."
                : "macOS will ask once. After allowing, this updates automatically."}
            </p>
          )}

          <div className="actions">
            {!granted && (
              <button className="primary" onClick={() => void requestPermission()}>
                grant access
              </button>
            )}
            <button onClick={() => void invoke("open_screen_settings")}>
              open settings
            </button>
            {granted && (
              <button onClick={() => void invoke("restart_app")}>restart</button>
            )}
          </div>

          <div className="actions secondary">
            <button className="ghost" onClick={() => setStep("welcome")}>
              back
            </button>
            <button className="ghost" onClick={() => setStep("durations")}>
              {granted ? "next →" : "skip for now →"}
            </button>
          </div>
        </section>
      )}

      {step === "durations" && (
        <section className="card">
          <h2>your rhythm</h2>
          <p className="lead">Pick a focus / break cadence, or use the classic.</p>

          <div className="dur-fields">
            <label>
              focus
              <input
                type="number"
                min={1}
                max={180}
                value={workMin}
                onChange={(e) => setWorkMin(Number(e.target.value) || 1)}
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
                onChange={(e) => setBreakMin(Number(e.target.value) || 1)}
              />
              min
            </label>
          </div>

          <div className="actions">
            <button
              onClick={() => {
                setWorkMin(25);
                setBreakMin(5);
              }}
            >
              use standard (25 / 5)
            </button>
          </div>

          <div className="actions secondary">
            <button className="ghost" onClick={() => setStep("permission")}>
              back
            </button>
            <button className="primary" onClick={() => void finish()}>
              start focusing
            </button>
          </div>
        </section>
      )}

      <ol className="steps">
        <li className={step === "welcome" ? "on" : ""} />
        <li className={step === "permission" ? "on" : ""} />
        <li className={step === "durations" ? "on" : ""} />
      </ol>
    </main>
  );
}
