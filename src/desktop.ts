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
  pickSavePath(defaultPath?: string): Promise<string | null>;
  writeTrack(
    baseDir: string,
    slug: string,
    files: DesktopFile[],
  ): Promise<{ ok: boolean; root: string; fbxPath?: string | null; error?: string }>;
  openInKsEditor(ksPath: string, fbxPath: string): Promise<{ ok: boolean; error?: string }>;
  openPath(p: string): Promise<void>;
  showMessage(type: 'info' | 'error' | 'warning', message: string): Promise<void>;
  confirm(message: string, detail?: string, buttons?: string[]): Promise<number>;
  getVersion(): Promise<string>;
  checkForUpdates(): Promise<void>;
  onUpdateStatus(cb: (s: UpdateStatus) => void): void;
  // --- AI training (ac-rl orchestration) ---
  rlListTracks(): Promise<{ ok: boolean; error?: string; tracks: RlTrack[] }>;
  rlStart(script: string, args?: (string | number)[]): Promise<{ ok: boolean; error?: string; pid?: number }>;
  rlStop(pid?: number): Promise<{ ok: boolean; note?: string }>;
  rlStatus(): Promise<RlStatus>;
  rlLive(track?: string): Promise<RlLive>;
  rlLogHistory(): Promise<string[]>;
  rlLaunchAC(
    track: string,
    opts?: { race?: boolean; opponents?: number; aiLevel?: number; laps?: number },
  ): Promise<{ ok: boolean; error?: string; cars?: number }>;
  rlRestoreSaved(track: string, folder: string): Promise<{ ok: boolean; error?: string }>;
  rlSuggestSetup(track: string): Promise<{ ok: boolean; car?: string; tips: string[]; brakeBias?: number | null; steps?: number; error?: string }>;
  onRlLog(cb: (line: string) => void): () => void;
  onRlStatus(cb: (s: RlStatus) => void): () => void;
}

export interface RlTrack {
  id: string;
  name: string;
  hasAi: boolean;
}

export interface RlProc {
  pid: number;
  script: string;
  args: string[];
  startedAt: number;
}

export interface RlStatus {
  running: RlProc[];
}

export interface RlLive {
  live: {
    reward?: number; ep_return?: number; episode?: number; trained?: number;
    step?: number; speed?: number; ds?: number; gear?: number; progress?: number;
    lat?: number; off?: number; damage?: number; steer?: number; gas?: number;
    brake?: number; note?: string;
  } | null;
  model: { steps: number; savedAt: number; car?: string } | null;
  banked: string[];
  saved?: RlSavedBot[];
}

export interface RlSavedBot {
  folder: string;
  label: string;
  date: string;
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
