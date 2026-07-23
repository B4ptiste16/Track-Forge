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

  // Race training uses the SAME trainer as normal — the bot now learns racing
  // automatically from any AI cars in the session (and from sim rivals in its
  // pretrained base). This just reminds you to have opponents on track.
  const raceTrain = async () => {
    const ok = await desktop!.confirm(
      'Race training',
      'Set up an AC RACE with AI opponents first (in Content Manager: Single → Race, add a few AI cars), and make sure the AC-RL overlay app is enabled — it feeds the bot the rival positions. Then start. The bot learns to race the cars that are actually on track.',
      ['Start race training', 'Cancel'],
    );
    if (ok !== 0) return;
    if (!liveBusy) await start('train.py');
  };

  // Bake the trained bot's own driven lap into the track's ai/fast_lane.ai, so
  // AC's built-in AI drives the bot's LINE + PACE. You can then spawn it as an
  // opponent and race against it while you drive — no multiplayer needed.
  const bakeAi = async () => {
    const ok = await desktop!.confirm(
      'Bake bot → AC AI line',
      'With AC open in a Practice session on this track (car on track, AC-RL overlay enabled), the bot will drive one clean lap and its line + speeds get written to the track’s AI line (ai/fast_lane.ai — the old one is backed up). Afterwards, AC’s AI opponents drive like your bot, so you can race against it. Ready?',
      ['Start baking', 'Cancel'],
    );
    if (ok !== 0) return;
    if (!liveBusy) await start('bot_to_ai.py');
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

  const [setup, setSetup] = useState<{ car?: string; tips: string[]; brakeBias?: number | null } | null>(null);
  const suggestSetup = async () => {
    if (!selected) return;
    setSetup({ tips: ['Analysing the bot’s telemetry…'] });
    const r = await desktop!.rlSuggestSetup(selected);
    setSetup(r.ok ? { car: r.car, tips: r.tips, brakeBias: r.brakeBias } : { tips: [r.error || 'failed'] });
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
              title={t.hasAi ? t.id : `${t.id} — no AI line found. Generate one in Content Manager (track → AI → generate) so the bot can see the layout, then it's trainable.`}
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
              <button onClick={raceTrain} disabled={liveBusy} title="Train against AI cars — the bot learns wheel-to-wheel racing from the rivals in the session.">
                🏁 Race training
              </button>
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
                  ? `steps trained${live.model.car ? ` · ${live.model.car}` : ''}${agoMin !== null ? ` · saved ${agoMin} min ago` : ''}`
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
              <button
                className="small train-reset-btn"
                onClick={bakeAi}
                disabled={liveBusy || !live.model}
                title="Have the bot drive a lap and write it as the track's AC AI line, so AC's AI drives like your bot and you can race it."
              >
                🏎️ Bake bot → AC AI line
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

              <div className="train-setup">
                <div className="train-setup-head">
                  <span className="train-card-title" style={{ margin: 0 }}>Suggested setup</span>
                  <button className="small" onClick={suggestSetup} disabled={!selected}>analyse</button>
                </div>
                {setup ? (
                  <div className="train-setup-body">
                    {setup.brakeBias != null && (
                      <div className="train-setup-bias">Brake bias ≈ <b>{setup.brakeBias}% front</b></div>
                    )}
                    <ul>{setup.tips.map((t, i) => <li key={i}>{t}</li>)}</ul>
                    {setup.car && <div className="muted">from telemetry of {setup.car}</div>}
                  </div>
                ) : (
                  <div className="muted">Once the bot laps cleanly, analyse its telemetry for brake-bias &amp; balance advice (apply it in AC’s setup screen).</div>
                )}
              </div>
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
