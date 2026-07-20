import { useEffect, useRef, useState } from 'react';
import { desktop } from '../desktop';
import type { RlLive, RlStatus, RlTrack } from '../desktop';

// AI Training cockpit: pick a track, launch AC on it, run the ac-rl python
// scripts, watch live telemetry and logs. The python side waits for a live AC
// session before it builds its env, so "Launch AC + Train" is genuinely one
// click: both start together and the trainer hooks on when the session is up.
export function TrainCenter({ onHome }: { onHome: () => void }) {
  const [tracks, setTracks] = useState<RlTrack[]>([]);
  const [tracksError, setTracksError] = useState('');
  const [selected, setSelected] = useState('');
  const [status, setStatus] = useState<RlStatus>({ running: false });
  const [live, setLive] = useState<RlLive>({ live: null, model: null, banked: [] });
  const [log, setLog] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  // mount: tracks, persisted selection, log history, subscriptions, polling
  useEffect(() => {
    const d = desktop;
    if (!d) return;
    d.rlListTracks().then((r) => {
      setTracks(r.tracks);
      if (!r.ok) setTracksError(r.error || 'Could not list tracks.');
    });
    d.getSettings().then((s) => { if (s.rlTrack) setSelected(s.rlTrack); });
    d.rlLogHistory().then(setLog);
    d.rlStatus().then(setStatus);
    const offLog = d.onRlLog((line) => setLog((l) => [...l.slice(-399), line]));
    const offStatus = d.onRlStatus(setStatus);
    const poll = setInterval(() => { d.rlLive().then(setLive); }, 1000);
    d.rlLive().then(setLive);
    return () => { offLog(); offStatus(); clearInterval(poll); };
  }, []);

  // keep the log scrolled to the bottom
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const pickTrack = (id: string) => {
    setSelected(id);
    const d = desktop;
    if (d) d.getSettings().then((s) => d.setSettings({ ...s, rlTrack: id }));
  };

  const start = async (script: string, args?: (string | number)[]) => {
    const r = await desktop!.rlStart(script, args);
    setNote(r.ok ? '' : r.error || 'failed');
    if (!r.ok && r.error) await desktop!.showMessage('error', r.error);
  };

  const launchAndTrain = async () => {
    if (!selected) { setNote('Pick a track first.'); return; }
    const ac = await desktop!.rlLaunchAC(selected);
    if (!ac.ok) { await desktop!.showMessage('error', ac.error || 'Could not launch AC.'); return; }
    setNote('AC launching — trainer will hook on when the session is live. ALT-TAB into AC.');
    await start('train.py');
  };

  const bank = async () => {
    const label = window.prompt('Label for this banked checkpoint:', 'solo');
    if (label) await start('bank_model.py', [label]);
  };

  const running = status.running;
  const lv = live.live;
  const fresh = running && lv; // live.json is only meaningful while a script runs
  const fmt = (n?: number) => (n === undefined || n === null ? '—' : n.toLocaleString('en-US'));
  const agoMin = live.model ? Math.round((Date.now() - live.model.savedAt) / 60000) : null;

  return (
    <div className="app train">
      <header className="toolbar">
        <button onClick={onHome} title="Back to home">⌂</button>
        <div className="brand">🤖 AI Training</div>
        <span className={`train-badge ${running ? 'on' : ''}`}>
          {running ? `${status.script} running` : 'idle'}
        </span>
        <div className="spacer" />
        {note && <span className="muted desktop-status">{note}</span>}
      </header>

      <div className="train-body">
        <aside className="train-tracks">
          <div className="train-section-title">Track</div>
          {tracksError && <div className="muted">{tracksError}</div>}
          {tracks.map((t) => (
            <button
              key={t.id}
              className={`train-track ${selected === t.id ? 'sel' : ''}`}
              onClick={() => pickTrack(t.id)}
              disabled={!t.hasAi}
              title={t.hasAi ? t.id : `${t.id} — no ai/fast_lane.ai, the bot can't train here`}
            >
              <span className="train-track-name">{t.name}</span>
              {!t.hasAi && <span className="train-track-noai">no AI line</span>}
            </button>
          ))}
        </aside>

        <main className="train-main">
          <div className="train-actions">
            <button className="primary train-big" onClick={launchAndTrain} disabled={running || !selected}>
              ▶ Launch AC + Train
            </button>
            <div className="train-actions-row">
              <button onClick={() => desktop!.rlLaunchAC(selected).then((r) => { if (!r.ok) desktop!.showMessage('error', r.error || 'failed'); })} disabled={!selected}>
                Launch AC only
              </button>
              <button onClick={() => start('train.py')} disabled={running}>Train (AC already open)</button>
              <button onClick={() => start('drive.py')} disabled={running}>Watch it drive</button>
              <button onClick={() => start('train_sim.py', [1_000_000, selected])} disabled={running || !selected}>
                Sim pre-train (no AC)
              </button>
              <button className="danger" onClick={() => desktop!.rlStop()} disabled={!running}>
                ■ Stop (saves first)
              </button>
            </div>
          </div>

          <div className="train-cards">
            <div className="train-card">
              <div className="train-card-title">Driver</div>
              <div className="train-stat-big">{live.model ? fmt(live.model.steps) : '—'}</div>
              <div className="muted">total steps trained{agoMin !== null ? ` · saved ${agoMin} min ago` : ''}</div>
              <div className="train-bank-row">
                <button className="small" onClick={bank} disabled={running || !live.model}>Bank checkpoint</button>
                <span className="muted">{live.banked.length} banked</span>
              </div>
            </div>

            <div className="train-card">
              <div className="train-card-title">Live</div>
              {fresh ? (
                <div className="train-live-grid">
                  <div><b>{lv!.speed ?? 0}</b><span>km/h</span></div>
                  <div><b>{lv!.reward ?? 0}</b><span>reward</span></div>
                  <div><b>{lv!.progress ?? 0}%</b><span>lap</span></div>
                  <div><b>{lv!.episode ?? 0}</b><span>episode</span></div>
                  <div><b>{fmt(lv!.trained)}</b><span>trained</span></div>
                  <div><b>{lv!.off ?? 0}s</b><span>off track</span></div>
                </div>
              ) : (
                <div className="muted">Telemetry appears here while a script is running.</div>
              )}
              {fresh && lv!.note && <div className="train-note">{lv!.note}</div>}
            </div>
          </div>

          <div className="train-log" ref={logRef}>
            {log.length === 0 && <div className="muted">Script output appears here.</div>}
            {log.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </main>
      </div>
    </div>
  );
}
