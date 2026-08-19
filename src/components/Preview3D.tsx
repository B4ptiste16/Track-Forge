import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { TrackProject } from '../types';
import type { BuiltTrack, MeshData } from '../geometry';
import { THEME_PALETTES, WALL_STYLE_COLORS, meshColor } from '../state/project';
import { genTextureUrls } from '../export/textures';

// VERTICAL EXAGGERATION (preview only — the exported track is never changed).
// A real circuit is far wider than it is tall: Monza climbs about 8 m across a
// 2.3 km site, which at fit-the-whole-track zoom is roughly THREE PIXELS. The
// elevation was always being built, it just could not be seen, which reads as
// "elevation doesn't work". Scaling height for display is how terrain editors
// have always solved this.
function toGeometry(mesh: MeshData, vScale = 1): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(mesh.vertices.length * 3);
  mesh.vertices.forEach((v, i) => {
    pos[i * 3] = v[0]; pos[i * 3 + 1] = v[1]; pos[i * 3 + 2] = v[2] * vScale;
  });
  const idx = new Uint32Array(mesh.faces.length * 3);
  mesh.faces.forEach((f, i) => {
    idx[i * 3] = f[0]; idx[i * 3 + 1] = f[1]; idx[i * 3 + 2] = f[2];
  });
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  // The preview needs UVs for the same reason the export does: without them a
  // texture has nowhere to land. Mirrors the exporter's planar fallback (4 m per
  // tile) so what you see here is mapped the way AC will map it.
  const uv = new Float32Array(mesh.vertices.length * 2);
  const hasUv = mesh.uvs && mesh.uvs.length === mesh.vertices.length;
  mesh.vertices.forEach((v, i) => {
    const u = hasUv ? mesh.uvs![i] : [v[0] / 4, v[1] / 4];
    uv[i * 2] = u[0]; uv[i * 2 + 1] = u[1];
  });
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (mesh.colors && mesh.colors.length === mesh.vertices.length) {
    const col = new Float32Array(mesh.colors.length * 3);
    mesh.colors.forEach((c, i) => {
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    });
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  return geo;
}

export function Preview3D({ project, built }: { project: TrackProject; built: BuiltTrack }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene>(null);
  const trackGroupRef = useRef<THREE.Group>(null);
  const rendererRef = useRef<THREE.WebGLRenderer>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera>(null);
  const [vScale, setVScale] = useState(1);
  const vScaleRef = useRef(1);
  const texCacheRef = useRef<Map<string, THREE.Texture>>(new Map());
  const texKeyRef = useRef('');
  vScaleRef.current = vScale;
  const controlsRef = useRef<OrbitControls>(null);
  const builtRef = useRef(built);
  builtRef.current = built;
  const hasFramedRef = useRef(false);

  // Fit the camera to the whole track (or, optionally, keep current target).
  const frameView = useCallback(() => {
    const cam = cameraRef.current;
    const controls = controlsRef.current;
    if (!cam || !controls) return;
    const box = new THREE.Box3();
    builtRef.current.centerline.forEach((s) =>
      box.expandByPoint(new THREE.Vector3(s.pos[0], s.pos[1], s.pos[2])),
    );
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = Math.max(20, box.getSize(new THREE.Vector3()).length());
    controls.target.copy(center);
    cam.position.set(center.x + size * 0.45, center.y - size * 0.55, center.z + size * 0.5);
    cam.near = Math.max(0.1, size / 5000);
    cam.far = size * 8;
    cam.updateProjectionMatrix();
    controls.maxDistance = size * 4;
    controls.update();
  }, []);

  // One-time init.
  useEffect(() => {
    const mount = mountRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.touchAction = 'none';
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(55, mount.clientWidth / mount.clientHeight, 0.5, 8000);
    camera.up.set(0, 0, 1); // Z-up to match the native/Blender frame
    camera.position.set(120, -120, 90);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = true; // pan in the view plane (intuitive)
    controls.rotateSpeed = 0.9;
    controls.panSpeed = 1.1;
    controls.minDistance = 0.4;
    controls.maxDistance = 6000;
    // Wheel zoom is handled manually below (see onWheel): OrbitControls scales
    // its dolly by the distance to `target`, so once you were near the pivot —
    // or aiming at something far from it — each scroll moved almost nothing.
    controls.enableZoom = false;
    // Left = rotate, right = pan, wheel = zoom; also allow middle-drag to pan.
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    controlsRef.current = controls;

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(0.3, 0.4, 1).multiplyScalar(200);
    scene.add(sun);
    scene.add(new THREE.AxesHelper(20));

    const group = new THREE.Group();
    scene.add(group);
    trackGroupRef.current = group;

    let raf = 0;
    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();

    const onResize = () => {
      const w = mount.clientWidth, h = mount.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    // Double-click to recentre on the clicked point.
    const raycaster = new THREE.Raycaster();
    // World point under a screen position: the track surface if the ray hits it,
    // otherwise the horizontal plane through the current pivot (so zooming at
    // the sky/background still behaves instead of doing nothing).
    const pointUnder = (clientX: number, clientY: number): THREE.Vector3 | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(group.children, true);
      if (hits.length) return hits[0].point.clone();
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -controls.target.z);
      const p = new THREE.Vector3();
      return raycaster.ray.intersectPlane(plane, p) ? p : null;
    };

    // ZOOM: dolly the camera AND the pivot along the ray to whatever is under
    // the cursor, by a FRACTION OF THE REMAINING DISTANCE to it. Because the
    // step scales with how far away the thing actually is, the zoom keeps biting
    // all the way in (the old behaviour ground to a halt as you approached) and
    // it converges on the cursor. Moving camera and target by the same vector is
    // a pure dolly, so the view never swings while zooming — and it leaves the
    // pivot sitting on the thing you zoomed into, which is what makes rotation
    // behave afterwards.
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const hit = pointUnder(ev.clientX, ev.clientY);
      if (!hit) return;
      const toHit = hit.clone().sub(camera.position);
      const dist = toHit.length();
      if (dist < 1e-4) return;
      toHit.divideScalar(dist); // normalise
      const notches = Math.max(-3, Math.min(3, ev.deltaY / 100));
      // 22% of the remaining distance per notch, and never more than 88% of the
      // way (so you approach a surface smoothly instead of punching through it).
      const frac = Math.min(0.88, 0.22 * Math.abs(notches));
      const step = (notches < 0 ? 1 : -1) * frac * dist;
      camera.position.addScaledVector(toHit, step);
      controls.target.addScaledVector(toHit, step);
      controls.update();
    };
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

    // ROTATE: before an orbit starts, put the pivot on whatever is at the CENTRE
    // of the view. The old pivot stayed at the track centre, so orbiting swept a
    // huge arc around a point far behind what you were inspecting. A point at
    // screen centre lies exactly along the view axis, so moving the pivot there
    // changes nothing on screen — it just shrinks the orbit radius to the thing
    // you're actually looking at.
    const onPointerDown = (ev: PointerEvent) => {
      if (ev.button !== 0) return; // left = rotate
      const rect = renderer.domElement.getBoundingClientRect();
      const centre = pointUnder(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (centre) {
        const d = camera.position.distanceTo(centre);
        if (d > 0.5 && d < 4000) controls.target.copy(centre);
      }
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);

    const onDblClick = (ev: MouseEvent) => {
      const hit = pointUnder(ev.clientX, ev.clientY);
      if (hit) {
        controls.target.copy(hit);
        controls.update();
      }
    };
    renderer.domElement.addEventListener('dblclick', onDblClick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('dblclick', onDblClick);
      renderer.domElement.removeEventListener('wheel', onWheel);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      controls.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  // Rebuild track meshes whenever geometry or theme changes.
  useEffect(() => {
    const group = trackGroupRef.current;
    const scene = sceneRef.current;
    if (!group || !scene) return;

    while (group.children.length) {
      const c = group.children.pop()!;
      (c as THREE.Mesh).geometry?.dispose?.();
    }

    const pal = THEME_PALETTES[project.meta.theme];
    scene.background = new THREE.Color(pal.background);

    // Draw the real textures once per look (theme / wall style / which surfaces
    // exist) — they are the same ones the export writes, so the preview shows
    // the actual material rather than a flat colour. Cached because grass alone
    // is ~17k blades to draw.
    const texKey = `${project.meta.theme}|${project.walls.style}|${built.meshes.map((m) => m.name).join(',')}`;
    if (texKeyRef.current !== texKey) {
      texKeyRef.current = texKey;
      for (const t of texCacheRef.current.values()) t.dispose();
      texCacheRef.current.clear();
      const urls = genTextureUrls(built, pal, project.meta.theme, project.walls.style);
      const loader = new THREE.TextureLoader();
      for (const [name, url] of urls) {
        const t = loader.load(url);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 8;
        texCacheRef.current.set(name, t);
      }
    }

    for (const mesh of built.meshes) {
      if (mesh.faces.length === 0) continue;
      const side = mesh.name === '1WALL' || mesh.name.startsWith('DECOR') ? THREE.DoubleSide : THREE.FrontSide;
      const vc = !!mesh.colors && mesh.colors.length === mesh.vertices.length;
      const baseColor =
        mesh.name === '1WALL'
          ? (WALL_STYLE_COLORS[project.walls.style] ?? pal.wall)
          : meshColor(mesh.name, pal);
      const map = texCacheRef.current.get(mesh.name.replace(/_\d+$/, '')) ?? null;
      // Grass cards are cut-outs: without alpha testing they show as solid
      // rectangles here exactly as they would in game.
      const cutout = mesh.name.startsWith('DECOR_GRASSTUFT');
      const mat = new THREE.MeshStandardMaterial({
        // A texture already carries the colour; tinting it again just muddies it.
        color: map ? '#ffffff' : (vc ? '#ffffff' : baseColor),
        map,
        vertexColors: vc && !map,
        transparent: cutout,
        alphaTest: cutout ? 0.35 : 0,
        roughness: 0.95,
        side: cutout ? THREE.DoubleSide : side,
      });
      group.add(new THREE.Mesh(toGeometry(mesh, vScaleRef.current), mat));
    }

    for (const e of built.empties) {
      const origin = new THREE.Vector3(e.position[0], e.position[1], e.position[2]);
      const fwd = new THREE.Vector3(e.basis[0][2], e.basis[1][2], e.basis[2][2]);
      const up = new THREE.Vector3(e.basis[0][1], e.basis[1][1], e.basis[2][1]);
      const isTime = e.name.startsWith('AC_TIME_');
      group.add(new THREE.ArrowHelper(fwd, origin, isTime ? 4 : 6, 0x33e0ff, 2, 1.2));
      group.add(new THREE.ArrowHelper(up, origin, 3, 0x39d353, 1.2, 0.8));
    }

    // Frame ONCE on first load; afterwards leave the user's camera alone so
    // editing doesn't yank the view around.
    if (!hasFramedRef.current && built.centerline.length > 1) {
      frameView();
      hasFramedRef.current = true;
    }
  }, [built, project.meta.theme, frameView, vScale]);

  return (
    <div className="preview3d" ref={mountRef}>
      <div className="preview-overlay">
        <button onClick={frameView} title="Fit the whole track in view">Reset view</button>
        <label className="preview-vscale" title="Stretch height in the PREVIEW ONLY so gradients are visible. A circuit is far wider than it is tall — real elevation is only a few pixels at full-track zoom. The exported track is unaffected.">
          height ×{vScale}
          <input type="range" min={1} max={25} step={1} value={vScale}
            onChange={(e) => setVScale(Number(e.target.value))} />
        </label>
        <span className="preview-hint" title="Left-drag rotate · Right-drag pan · Scroll zoom (toward cursor) · Double-click to recenter">
          drag&nbsp;rotate · RMB&nbsp;pan · scroll&nbsp;zoom · dbl-click&nbsp;recenter
        </span>
      </div>
    </div>
  );
}
