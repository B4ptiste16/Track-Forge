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
  ): Promise<{ ok: boolean; root: string; fbxPath?: string | null; error?: string }>;
  openInKsEditor(ksPath: string, fbxPath: string): Promise<{ ok: boolean; error?: string }>;
  openPath(p: string): Promise<void>;
  showMessage(type: 'info' | 'error' | 'warning', message: string): Promise<void>;
  getVersion(): Promise<string>;
  checkForUpdates(): Promise<void>;
  onUpdateStatus(cb: (s: UpdateStatus) => void): void;
}

export interface UpdateStatus {
  state: 'checking' | 'available' | 'none' | 'downloading' | 'downloaded' | 'error' | 'dev';
  version?: string;
  percent?: number;
  message?: string;
}

export const desktop: DesktopApi | undefined = (
  globalThis as unknown as { desktop?: DesktopApi }
).desktop;
