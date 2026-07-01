import { useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { TrackProject, Segment } from './types';
import { buildTrack, buildCenterline } from './geometry';
import { defaultProject, syncCorners, uniformCorners, withDefaults, syncRunoff, minCornerRadius } from './state/project';
import { closeLoop } from './geometry/closeLoop';
import { buildPackage, triggerDownload, downloadProjectJson } from './export/zip';
import { SegmentList } from './components/SegmentList';
import { SegmentEditor2D } from './components/SegmentEditor2D';
import { Preview3D } from './components/Preview3D';
import { InputsPanel } from './components/InputsPanel';
import { KerbConfig } from './components/KerbConfig';
import { RunoffPanel } from './components/RunoffPanel';
import { DesktopBar } from './components/DesktopBar';
import { desktop } from './desktop';
import './App.css';

export default function App() {
  const [project, setProject] = useState<TrackProject>(() => defaultProject());
  const [customize, setCustomize] = useState(false);
  const [busy, setBusy] = useState(false);
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
    // Cap corner radii to what the road width can turn (prevents fold-over).
    const minR = minCornerRadius(project.road.width);
    const segments = rawSegments.map((s) =>
      s.kind === 'corner' ? { ...s, radius: Math.max(s.radius, minR) } : s,
    );
    const corners = syncCorners(segments, project.corners, project.road.defaultKerb);
    const runoff = syncRunoff(segments, project.runoff, project.runoffDefault);
    const total = buildCenterline(segments).totalLength;
    const startFinishDist = Math.min(project.startFinishDist, total);
    setProject({ ...project, segments, corners, runoff, startFinishDist });
  };

  const onCloseLoop = () => setSegments(closeLoop(project.segments));

  const onLoadFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const p = withDefaults(JSON.parse(String(reader.result)) as TrackProject);
        // Re-sync corners in case the file is older / partial.
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

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">🏁 AC Track Forge</div>
        <div className="spacer" />
        <button onClick={() => { setProject(defaultProject()); setCustomize(false); }}>New</button>
        <button onClick={() => downloadProjectJson(project)}>Save project</button>
        <button onClick={() => fileRef.current?.click()}>Load project</button>
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
          />
        </main>

        <aside className="right">
          <InputsPanel project={project} built={built} onChange={setProject} />
          <KerbConfig
            project={project}
            customize={customize}
            onCustomizeChange={setCustomize}
            onChange={setProject}
          />
          <RunoffPanel project={project} built={built} onChange={setProject} />
        </aside>
      </div>
    </div>
  );
}
