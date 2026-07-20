import { useEffect, useRef, useState } from 'react';
import { desktop } from '../desktop';
import type { RlLive, RlStatus, RlTrack } from '../desktop';

const LIVE_SCRIPTS = new Set(['train.py', 'drive.py']);

// AI Training cockpit. EACH TRACK HAS ITS OWN BOT (models/tracks/<track>/):
// the Driver card shows the SELECTED track's bot, and a brand-new track
// starts from the shared sim-pretrained base. Two trainings can run at once:
// one live in AC + one in the offline sim (they write to different folders,
// and each has its own stop flag). The live trainer reads the track from AC's
// telemetry, so the bot being trained ALWAYS matches the loaded session.
export function TrainCenter({ onHome }: { onHome: () => void }) {
  const [tracks, setTracks] = useState<RlTrack[]>([]);
  const [tracksError, setTracksError] = useState('');
  const [selected, setSelected] = useState('');
  const [status, setStatus] = useState<RlStatus>({ running: [] });
  const [live, setLive] = useState<RlLive>({ live: null, model: null, banked: [] });
  const [log, setLog] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

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
    const poll = setInterval(() => { d.rlLive(selectedRef.current).then(setLive); }, 1000);
    return () => { offLog(); offStatus(); clearInterval(poll); };
  }, []);

  // selecting a track refreshes ITS bot's stats immediately
  useEffect(() => {
    if (desktop && selected) desktop.rlLive(selected).then(setLive);
  }, [selected]);

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
    const label = window.prompt(`Label for this banked checkpoint of "${selected}":`, 'solo');
    if (label) await start('bank_model.py', [label, selected]);
  };

  // Close out THIS track's driver under a name, then start it fresh — from
  // the shared sim-pretrained base (fast), from a freshly retrained base
  // (slower), or completely BLANK with no pre-training at all. Recorded
  // laps/demos are never touched.
  const saveAndReset = async () => {
    const label = window.prompt(`Name "${selected}"'s current training before starting a new one:`, '');
    if (!label) return;
    const choice = await desktop!.confirm(
      `Start a new training run for "${selected}"`,
      `"${label}" will be archived (nothing is deleted) and appear under Saved bots. Other tracks are not affected. How should the new run begin?`,
      ['Keep pretrained base (fast)', 'Redo pretraining (slower)', 'Blank — no pre-training', 'Cancel'],
    );
    if (choice === 3 || choice === undefined) return;
    const mode = choice === 0 ? 'keep' : choice === 1 ? 'redo' : 'none';
    await start('save_and_reset.py', [label, mode, selected]);
  };

  const restoreSaved = async (folder: string, label: string) => {
    const ok = await desktop!.confirm(
      `Restore "${label}" as ${selected}'s live bot?`,
      'The current bot (if any) is archived first — nothing is lost.',
      ['Restore', 'Cancel'],
    );
    if (ok !== 0) return;
    const r = await desktop!.rlRestoreSaved(selected, folder);
    if (!r.ok) await desktop!.showMessage('error', r.error || 'Restore failed.');
    else desktop!.rlLive(selected).then(setLive);
  };

  const running = status.running;
  const liveBusy = running.some((p) => LIVE_SCRIPTS.has(p.script));
  const simBusy = running.some((p) => p.script === 'train_sim.py');
  const anyBusy = running.length > 0;
  const lv = live.live;
  const fresh = liveBusy && lv; // live.json only reflects the LIVE (AC) script
  const fmt = (n?: number) => (n === undefined || n === null ? '—' : n.toLocaleString('en-US'));
  const agoMin = live.model ? Math.round((Date.now() - live.model.savedAt) / 60000) : null;
  const selName = tracks.find((t) => t.id === selected)?.name || selected || 'no track selected';

  return (
    <div className="app train">
      <header className="toolbar">
        <button onClick={onHome} title="Back to home">⌂</button>
        <div className="brand">🤖 AI Training</div>
        {running.length === 0 && <span className="train-badge">idle</span>}
        {running.map((p) => (
          <span key={p.pid} className="train-badge on">
            {p.script === 'train_sim.py' ? `sim training${p.args[1] ? ` (${p.args[1]})` : ''}` : p.script.replace('.py', '')}
            <button className="train-badge-stop" title="Stop this (saves first)" onClick={() => desktop!.rlStop(p.pid)}>■</button>
          </span>
        ))}
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
            <button className="primary train-big" onClick={launchAndTrain} disabled={liveBusy || !selected}>
              ▶ Launch AC + Train
            </button>
            <div className="train-actions-row">
              <button onClick={() => desktop!.rlLaunchAC(selected).then((r) => { if (!r.ok) desktop!.showMessage('error', r.error || 'failed'); })} disabled={!selected || liveBusy}>
                Launch AC only
              </button>
              <button onClick={() => start('train.py')} disabled={liveBusy}>Train (AC already open)</button>
              <button onClick={() => start('drive.py')} disabled={liveBusy}>Watch it drive</button>
              <button
                onClick={() => start('train_sim.py', [1_000_000, selected])}
                disabled={simBusy || !selected}
                title="Improves the shared pretrained base, focused on this track. No AC needed — safe to run WHILE another track trains live."
              >
                Sim pre-train (no AC)
              </button>
              <button className="danger" onClick={() => desktop!.rlStop()} disabled={!anyBusy}>
                ■ Stop all (saves first)
              </button>
            </div>
          </div>

          <div className="train-cards">
            <div className="train-card">
              <div className="train-card-title">Driver — {selName}</div>
              <div className="train-stat-big">{live.model ? fmt(live.model.steps) : '—'}</div>
              <div className="muted">
                {live.model
                  ? `steps trained on this track${agoMin !== null ? ` · saved ${agoMin} min ago` : ''}`
                  : selected
                    ? 'no bot for this track yet — it will start from the shared pretrained base'
                    : 'select a track'}
              </div>
              <div className="train-bank-row">
                <button className="small" onClick={bank} disabled={anyBusy || !live.model}>Bank checkpoint</button>
                <span className="muted">{live.banked.length} banked</span>
              </div>
              <button
                className="small train-reset-btn"
                onClick={saveAndReset}
                disabled={anyBusy || !selected}
                title="Archive this track's driver under a name, then start it fresh"
              >
                💾 Save & start new training…
              </button>
              {(live.saved?.length ?? 0) > 0 && (
                <div className="train-saved">
                  <div className="train-card-title">Saved bots — {selName}</div>
                  {live.saved!.map((s) => (
                    <div key={s.folder} className="train-saved-row">
                      <span className="train-saved-name" title={s.folder}>{s.label}</span>
                      <span className="muted">{s.date}</span>
                      <button className="small" disabled={anyBusy} onClick={() => restoreSaved(s.folder, s.label)}>
                        restore
                      </button>
                    </div>
                  ))}
                </div>
              )}
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
                <div className="muted">
                  {simBusy && !liveBusy
                    ? 'Sim training runs headless — watch its progress in the log below.'
                    : 'Telemetry appears here while a live AC script is running.'}
                </div>
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
