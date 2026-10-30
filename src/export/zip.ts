import JSZip from 'jszip';
import type { TrackProject } from '../types';
import { slugify } from '../state/project';
import { buildFileMap, drivePackage, type BuildOptions, type TrackFile } from './files';

// The drag-and-drop track package. Laid out as content/tracks/<slug>/..., the
// layout of the game folder itself, so the same zip installs by dropping it on
// Content Manager AND by extracting it straight into the Assetto Corsa folder.
// Holds the KN5 and everything else AC reads - nothing left to compile.
export async function buildTrackZip(
  project: TrackProject,
  opts: BuildOptions = {},
): Promise<{ bytes: Uint8Array; slug: string; missingTextures: string[] }> {
  const { slug, files, missingTextures } = buildFileMap(project, undefined, opts);
  const zip = new JSZip();
  const root = `content/tracks/${slug}/`;
  for (const f of drivePackage(files)) {
    if (f.text !== undefined) zip.file(root + f.path, f.text);
    else if (f.bytes) zip.file(root + f.path, f.bytes);
  }
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { bytes, slug, missingTextures };
}

// Browser download path: the same package as a Blob.
export async function buildPackage(project: TrackProject): Promise<{ blob: Blob; slug: string }> {
  const { bytes, slug } = await buildTrackZip(project);
  return { blob: new Blob([new Uint8Array(bytes)], { type: 'application/zip' }), slug };
}

export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadProjectJson(project: TrackProject): void {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  triggerDownload(blob, `${slugify(project.meta.name)}.acforge.json`);
}

// ---- Desktop (Electron) helpers ----

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// Serialize the file map for transfer to the Electron main process.
export function serializeForDesktop(files: TrackFile[]): { path: string; data: string; encoding: 'utf8' | 'base64' }[] {
  return files.map((f) =>
    f.text !== undefined
      ? { path: f.path, data: f.text, encoding: 'utf8' as const }
      : { path: f.path, data: bytesToBase64(f.bytes!), encoding: 'base64' as const },
  );
}
