import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Blockers.css";

interface Config {
  blocker_enabled: boolean;
  blocked_sites: string[];
  blocked_apps: string[];
}

interface AppInfo {
  name: string;
  bundle_id: string;
}

const isTauri = "__TAURI_INTERNALS__" in window;

/** Reduce user input to a bare domain: "https://www.Reddit.com/r/x" -> "reddit.com". */
function normalizeDomain(raw: string): string {
  let d = raw.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, ""); // scheme
  d = d.replace(/\/.*$/, ""); // path
  d = d.replace(/^www\./, "");
  return d;
}

export default function Blockers({ onClose }: { onClose: () => void }) {
  const [enabled, setEnabled] = useState(false);
  const [sites, setSites] = useState<string[]>([]);
  const [apps, setApps] = useState<string[]>([]); // bundle ids
  const [running, setRunning] = useState<AppInfo[]>([]);
  const [siteInput, setSiteInput] = useState("");
  const [appPick, setAppPick] = useState("");

  useEffect(() => {
    if (!isTauri) {
      // Browser demo defaults so the panel is previewable.
      setEnabled(true);
      setSites(["reddit.com", "youtube.com"]);
      setApps(["com.tinyspeck.slackmacgap"]);
      setRunning([
        { name: "Slack", bundle_id: "com.tinyspeck.slackmacgap" },
        { name: "Discord", bundle_id: "com.hnc.Discord" },
        { name: "Spotify", bundle_id: "com.spotify.client" },
      ]);
      return;
    }
    void (async () => {
      const cfg = await invoke<Config>("get_config");
      setEnabled(cfg.blocker_enabled);
      setSites(cfg.blocked_sites);
      setApps(cfg.blocked_apps);
      setRunning(await invoke<AppInfo[]>("list_running_apps"));
    })();
  }, []);

  // Persist and update local state together so the backend re-applies mid-focus.
  const persist = (e: boolean, s: string[], a: string[]) => {
    setEnabled(e);
    setSites(s);
    setApps(a);
    if (isTauri) void invoke("set_blocker_config", { enabled: e, sites: s, apps: a });
  };

  const nameFor = (bid: string) => running.find((a) => a.bundle_id === bid)?.name ?? bid;

  const addSite = () => {
    const d = normalizeDomain(siteInput);
    if (d && !sites.includes(d)) persist(enabled, [...sites, d], apps);
    setSiteInput("");
  };
  const addApp = () => {
    if (appPick && !apps.includes(appPick)) persist(enabled, sites, [...apps, appPick]);
    setAppPick("");
  };

  const pickable = useMemo(
    () => running.filter((a) => !apps.includes(a.bundle_id)),
    [running, apps],
  );

  return (
    <div className="blockers-scrim" onClick={onClose}>
      <section className="blockers" onClick={(e) => e.stopPropagation()}>
        <header className="blockers-head">
          <h2>distraction blockers</h2>
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </header>

        <label className="toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => persist(e.target.checked, sites, apps)}
          />
          <span>block these during focus time</span>
        </label>

        <div className={enabled ? "" : "disabled"}>
          <div className="group">
            <h3>websites</h3>
            <p className="hint">Blocked via /etc/hosts — asks for your admin password.</p>
            <div className="chips">
              {sites.map((s) => (
                <span className="chip" key={s}>
                  {s}
                  <button
                    onClick={() => persist(enabled, sites.filter((x) => x !== s), apps)}
                  >
                    ✕
                  </button>
                </span>
              ))}
              {sites.length === 0 && <span className="empty">no sites yet</span>}
            </div>
            <div className="add">
              <input
                type="text"
                placeholder="reddit.com"
                value={siteInput}
                onChange={(e) => setSiteInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addSite()}
              />
              <button onClick={addSite}>add</button>
            </div>
          </div>

          <div className="group">
            <h3>apps</h3>
            <p className="hint">Quit automatically if opened during focus.</p>
            <div className="chips">
              {apps.map((b) => (
                <span className="chip" key={b}>
                  {nameFor(b)}
                  <button
                    onClick={() => persist(enabled, sites, apps.filter((x) => x !== b))}
                  >
                    ✕
                  </button>
                </span>
              ))}
              {apps.length === 0 && <span className="empty">no apps yet</span>}
            </div>
            <div className="add">
              <select value={appPick} onChange={(e) => setAppPick(e.target.value)}>
                <option value="">choose a running app…</option>
                {pickable.map((a) => (
                  <option key={a.bundle_id} value={a.bundle_id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <button onClick={addApp} disabled={!appPick}>
                add
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
