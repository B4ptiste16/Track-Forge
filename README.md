# AC Track Forge

A browser app for designing **Assetto Corsa** circuits from connected straight + corner
segments, then exporting a package that produces a working, drivable track with minimal
manual steps.

The whole point: a program that *generates* the geometry can make the four classic
"dead track" mistakes impossible — wrong scale, flipped normals, overlapping physical
meshes, and mis-oriented spawn objects. The JS geometry engine in `src/geometry/` is the
**single source of truth**: it drives both the live 3D preview and the baked Blender
export, so what you see is what you get.

## Run it

```bash
npm install

# Web (browser) — exports a .zip you download
npm run dev            # http://localhost:5173
npm run build          # type-check + production build

# Desktop app (Electron) — writes the track folder straight to disk + KsEditor
npm run electron:dev   # runs Vite + opens the desktop window
npm run electron:build # packages an installer into release/
```

> **Windows + OneDrive note:** if the project lives under OneDrive-synced `Documents`,
> `electron-builder` fails with `EPERM: rename …win-…-unpacked.tmp`. Build to a
> non-synced folder instead:
> ```
> npx electron-builder --win "--config.directories.output=C:\Users\<you>\tf-release"
> ```
> (or move the project out of the OneDrive folder).

## Desktop app

The desktop build (Electron) adds what a browser can't:
- **Export folder** — writes the whole `content/tracks/<slug>/` folder straight to disk
  (point it at your AC `content/tracks` once and it's one click after that).
- **Open in KsEditor** — launches KsEditor on the exported FBX (set `KsEditor.exe`'s
  path once in the ⚙ settings). You then just assign shaders (using the bundled
  `texture/*.png`) and **Export KN5** — the one step that must stay in KsEditor, because
  KN5 is Kunos's proprietary format with no embeddable writer.

In the browser build these are replaced by a single **Export track** zip download.

## How it works

1. **Design** — add straights and corners (auto-numbered T1, T2, …) or drop in a **chicane**,
   set width, elevation, per-corner kerbs, start/finish line, grid, and **pit lane**. The 2D
   top view is **interactive**: drag the ● handle on a corner to change its radius, the ○
   handle to change its angle. The 3D preview (Z-up, orbit camera) shows the exact export mesh.
2. **Runoff & barriers** — per section, per side, pick **grass / gravel / concrete / wall**
   with a width (or wall distance), plus solid or tyre/poly **block** barriers. **Auto-clip**
   shrinks runoff so it never overlaps a nearby part of the track (parallel straights, hairpin
   throats), and inside-corner barriers are pulled in so they never fold across the road.
   Add **escape roads** (paved, open) on the outside of any corner.
3. **Close the loop** — the closure readout shows the gap + heading error; **Close loop**
   appends a best-fit tail (one or two corners + straights) to drive both toward zero.
4. **Bridges** — where the track crosses over itself, the later pass is automatically raised
   into an overpass. An **incline slider** controls how aggressive the ramps are.
5. **Export** — produces `<trackname>.zip` containing a ready-to-import **`<trackname>.fbx`**:
   1:1 scale, normals up, one surface keyword per object
   (`1ROAD`/`1KERB`/`1GRASS`/`1SAND`/`1CONCRETE`/`1WALL`/`1PIT`), a **coloured material
   assigned to every mesh**, and oriented `AC_*` spawn/timing nulls (+Z = travel, +Y = up,
   scale 1). Plus `data/surfaces.ini`, `ui/ui_track.json` (pitboxes matched to `AC_PIT_*`),
   tailored `INSTRUCTIONS.md`, the project JSON, and a `blender_fallback/build_track.py`.
6. **Finish in KsEditor** — import the FBX, export KN5 (the one unavoidable GUI step), drop the
   folder into `assettocorsa/content/tracks/`. Full steps are in the exported `INSTRUCTIONS.md`.

## Layout

```
src/
  types.ts              data model (also the save/load project format)
  geometry/             the engine (single source of truth)
    centerline.ts       segments -> centerline samples, closure
    elevation.ts        Catmull-Rom height profile
    road.ts kerbs.ts ground.ts walls.ts pitlane.ts   surface meshes (normals forced up)
    bridges.ts          self-crossing detection + auto overpass elevation
    spawns.ts           spawn/timing empties (+Z travel, +Y up, scale 1)
    closeLoop.ts        best-effort loop closer
    build.ts            orchestrator -> BuiltTrack
  export/               fbx.ts (direct ASCII FBX), blenderScript.ts (fallback),
                        surfaces.ini, ui_track.json, INSTRUCTIONS.md, zip
  components/           SegmentEditor2D (drag handles), Preview3D, InputsPanel, KerbConfig, ...
  state/project.ts      defaults, theme palettes, corner sync, slugify
  dev/fbxloader.ts      dev-only: re-export three's FBXLoader for round-trip validation
scripts/verify_export.mts   dev: write export artifacts to disk for validation
```

## Phase 2 (not built yet)

Run the identical `build_track.py` with headless Blender
(`blender --background --python build_track.py`) on a server so the site turns a design
straight into a downloadable FBX. The KsEditor KN5 step is GUI-bound and stays manual.
