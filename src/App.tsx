import { useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { TrackProject, Segment } from './types';
import { buildTrack, buildCenterline } from './geometry';
import {
  defaultProject, syncCorners, uniformCorners, withDefaults, minCornerRadius,
  snapshotLayout, applyLayout, newZoneId,
} from './state/project';
import { closeLoop } from './geometry/closeLoop';
import { buildPackage, triggerDownload, downloadProjectJson } from './export/zip';
import { SegmentList } from './components/SegmentList';
import { SegmentEditor2D } from './components/SegmentEditor2D';
import { Preview3D } from './components/Preview3D';
import { InputsPanel } from './components/InputsPanel';
import { KerbConfig } from './components/KerbConfig';
import { TracksidePanel } from './components/TracksidePanel';
import { FacilitiesPanel, newBuildingId } from './components/FacilitiesPanel';
import { DesktopBar } from './components/DesktopBar';
import { desktop } from './desktop';
import './App.css';

type Tab = 'track' | 'kerbs' | 'trackside' | 'facilities';

export default function App() {
  const [project, setProject] = useState<TrackProject>(() => defaultProject());
  const [customize, setCustomize] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>('track');
  const fileRef = useRef<HTMLInputElement>(null);

  // When customizing is off, all corners use the default kerb (without losing
  // any per-corner edits stored in project.corners).
  const effective = useMemo<TrackProject>(
    () =>
      customize
        ? project
        : { ...project, corners: uniformCorners(project.segments, project.road.defaultKerb, project.corners) },
    [project, customize],
  );

  const built = useMemo(() => buildTrack(effective), [effective]);

  // Edit segments: keep CornerConfig[] sized and clamp the S/F slider.
  const setSegments = (rawSegments: Segment[]) => {
    const minR = minCornerRadius(project.road.width);
    const segments = rawSegments.map((s) =>
      s.kind === 'corner' ? { ...s, radius: Math.max(s.radius, minR) } : s,
    );
    const corners = syncCorners(segments, project.corners, project.road.defaultKerb);
    const total = buildCenterline(segments).totalLength;
    const startFinishDist = Math.min(project.startFinishDist, total);
    setProject({ ...project, segments, corners, startFinishDist });
  };

  const onCloseLoop = () => setSegments(closeLoop(project.segments));

  const onLoadFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const p = withDefaults(JSON.parse(String(reader.result)) as TrackProject);
        p.corners = syncCorners(p.segments, p.corners ?? [], p.road.defaultKerb);
        setProject(p);
        setCustomize(
          p.corners.some(
            (c) => !(c.entry === c.apex && c.apex === c.exit && c.entry === p.road.defaultKerb),
          ),
        );
      } catch {
        alert('Could not read that project file.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const onExport = async () => {
    if (!built.closure.closed) {
      const ok = window.confirm(
        `The loop is not closed (gap ${built.closure.gap.toFixed(1)} m, heading off ${built.closure.headingOff.toFixed(0)}°).\n\n` +
          'The start/finish may be discontinuous. Export anyway?',
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      const { blob, slug } = await buildPackage(effective);
      triggerDownload(blob, `${slug}.zip`);
    } finally {
      setBusy(false);
    }
  };

  // ---- alternate layouts ---------------------------------------------------
  const layouts = project.layouts ?? [];
  const saveLayoutAs = () => {
    const name = window.prompt('Layout name:', `layout ${layouts.length + 1}`);
    if (!name) return;
    const snap = snapshotLayout(project, name);
    const others = layouts.filter((l) => l.name !== name);
    setProject({ ...project, layouts: [...others, snap] });
  };
  const loadLayout = (name: string) => {
    const l = layouts.find((x) => x.name === name);
    if (!l) return;
    if (!window.confirm(`Switch to layout "${name}"? Unsaved shape changes are replaced (save a layout first to keep them).`)) return;
    setProject(applyLayout(project, l));
  };
  const deleteLayout = (name: string) => {
    if (!window.confirm(`Delete layout "${name}"?`)) return;
    setProject({ ...project, layouts: layouts.filter((l) => l.name !== name) });
  };

  // ---- 2D editor callbacks ---------------------------------------------------
  const onZonePicked = (from: number, to: number, side: 'left' | 'right') => {
    const base = project.trackside[side];
    setProject({
      ...project,
      trackside: {
        ...project.trackside,
        zones: [...project.trackside.zones, { id: newZoneId(), side, from: Math.round(from), to: Math.round(to), ...base }],
      },
    });
    setTab('trackside');
  };
  const onPlaceBuilding = (x: number, y: number) => {
    setProject({
      ...project,
      buildings: [...project.buildings, { id: newBuildingId(), x, y, w: 20, d: 12, h: 6, rot: 0 }],
    });
    setTab('facilities');
  };

  const TABS: { id: Tab; label: string }[] = [
    { id: 'track', label: 'Track' },
    { id: 'kerbs', label: 'Kerbs' },
    { id: 'trackside', label: 'Trackside' },
    { id: 'facilities', label: 'Pit & Buildings' },
  ];

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">🏁 AC Track Forge</div>
        <div className="tb-group">
          <button onClick={() => { setProject(defaultProject()); setCustomize(false); }}>New</button>
          <button onClick={() => downloadProjectJson(project)}>Save project</button>
          <button onClick={() => fileRef.current?.click()}>Load project</button>
        </div>
        <div className="tb-group">
          <span className="tb-label">Layout</span>
          <select
            value=""
            onChange={(e) => { if (e.target.value) loadLayout(e.target.value); }}
            title="Switch to a saved alternate layout"
          >
            <option value="">{layouts.length ? 'switch to…' : 'none saved'}</option>
            {layouts.map((l) => <option key={l.name} value={l.name}>{l.name}</option>)}
          </select>
          <button onClick={saveLayoutAs} title="Save the current shape as a named layout">Save layout</button>
          {layouts.length > 0 && (
            <button
              className="danger"
              onClick={() => { const n = window.prompt('Delete which layout?', layouts[layouts.length - 1]?.name); if (n) deleteLayout(n); }}
            >
              Delete…
            </button>
          )}
        </div>
        <div className="spacer" />
        {desktop ? (
          <DesktopBar project={effective} />
        ) : (
          <button className="primary" onClick={onExport} disabled={busy}>
            {busy ? 'Exporting…' : 'Export track'}
          </button>
        )}
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={onLoadFile} />
      </header>

      <div className="body">
        <aside className="left">
          <SegmentList segments={project.segments} onChange={setSegments} />
        </aside>

        <main className="center">
          <Preview3D project={effective} built={built} />
          <SegmentEditor2D
            project={effective}
            built={built}
            onCloseLoop={onCloseLoop}
            onSegmentsChange={setSegments}
            onManualWallsChange={(manualWalls) => setProject({ ...project, manualWalls })}
            onZonePicked={onZonePicked}
            onPlaceBuilding={onPlaceBuilding}
          />
        </main>

        <aside className="right">
          <nav className="tabs">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          <div className="tab-body">
            {tab === 'track' && <InputsPanel project={project} built={built} onChange={setProject} />}
            {tab === 'kerbs' && (
              <KerbConfig
                project={project}
                customize={customize}
                onCustomizeChange={setCustomize}
                onChange={setProject}
              />
            )}
            {tab === 'trackside' && <TracksidePanel project={project} built={built} onChange={setProject} />}
            {tab === 'facilities' && <FacilitiesPanel project={project} built={built} onChange={setProject} />}
          </div>
        </aside>
      </div>
    </div>
  );
}
