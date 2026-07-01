import JSZip from 'jszip';
import type { TrackProject } from '../types';
import { slugify } from '../state/project';
import { buildFileMap, type TrackFile } from './files';

// Assemble the export .zip from the shared file map (browser download path).
export async function buildPackage(project: TrackProject): Promise<{ blob: Blob; slug: string }> {
  const { slug, files } = buildFileMap(project);
  const zip = new JSZip();
  for (const f of files) {
    if (f.text !== undefined) zip.file(f.path, f.text);
    else if (f.bytes) zip.file(f.path, f.bytes);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  return { blob, slug };
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
