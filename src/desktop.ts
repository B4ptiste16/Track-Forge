// Typed accessor for the Electron bridge exposed by electron/preload.cjs.
// Undefined when running as a plain website.

export interface DesktopFile {
  path: string;
  data: string;
  encoding: 'utf8' | 'base64';
}

export interface DesktopApi {
  isDesktop: boolean;
  getSettings(): Promise<Record<string, string>>;
  setSettings(s: Record<string, string>): Promise<boolean>;
  pickFolder(): Promise<string | null>;
  pickFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
  writeTrack(
    baseDir: string,
    slug: string,
    files: DesktopFile[],
  ): Promise<{ root: string; fbxPath: string | null }>;
  openInKsEditor(ksPath: string, fbxPath: string): Promise<{ ok: boolean; error?: string }>;
  openPath(p: string): Promise<void>;
}

export const desktop: DesktopApi | undefined = (
  globalThis as unknown as { desktop?: DesktopApi }
).desktop;
