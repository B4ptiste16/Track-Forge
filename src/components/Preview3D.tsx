import { useCallback, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { TrackProject } from '../types';
import type { BuiltTrack, MeshData } from '../geometry';
import { THEME_PALETTES, WALL_STYLE_COLORS, meshColor } from '../state/project';

function toGeometry(mesh: MeshData): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(mesh.vertices.length * 3);
  mesh.vertices.forEach((v, i) => {
    pos[i * 3] = v[0]; pos[i * 3 + 1] = v[1]; pos[i * 3 + 2] = v[2];
  });
  const idx = new Uint32Array(mesh.faces.length * 3);
  mesh.faces.forEach((f, i) => {
    idx[i * 3] = f[0]; idx[i * 3 + 1] = f[1]; idx[i * 3 + 2] = f[2];
  });
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
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
    controls.zoomToCursor = true;       // zoom toward the cursor / a corner
    controls.rotateSpeed = 0.9;
    controls.zoomSpeed = 1.4;
    controls.panSpeed = 1.1;
    controls.minDistance = 2;
    controls.maxDistance = 6000;
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
    const onDblClick = (ev: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(group.children, true);
      if (hits.length) {
        controls.target.copy(hits[0].point);
        controls.update();
      }
    };
    renderer.domElement.addEventListener('dblclick', onDblClick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('dblclick', onDblClick);
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

    for (const mesh of built.meshes) {
      if (mesh.faces.length === 0) continue;
      const side = mesh.name === '1WALL' || mesh.name.startsWith('DECOR') ? THREE.DoubleSide : THREE.FrontSide;
      const vc = !!mesh.colors && mesh.colors.length === mesh.vertices.length;
      const baseColor =
        mesh.name === '1WALL'
          ? (WALL_STYLE_COLORS[project.walls.style] ?? pal.wall)
          : meshColor(mesh.name, pal);
      const mat = new THREE.MeshStandardMaterial({
        color: vc ? '#ffffff' : baseColor,
        vertexColors: vc,
        roughness: 0.95,
        side,
      });
      group.add(new THREE.Mesh(toGeometry(mesh), mat));
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
  }, [built, project.meta.theme, frameView]);

  return (
    <div className="preview3d" ref={mountRef}>
      <div className="preview-overlay">
        <button onClick={frameView} title="Fit the whole track in view">Reset view</button>
        <span className="preview-hint" title="Left-drag rotate · Right-drag pan · Scroll zoom (toward cursor) · Double-click to recenter">
          drag&nbsp;rotate · RMB&nbsp;pan · scroll&nbsp;zoom · dbl-click&nbsp;recenter
        </span>
      </div>
    </div>
  );
}
