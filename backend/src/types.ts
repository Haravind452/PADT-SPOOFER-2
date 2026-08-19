export type GenMode = 'fast' | 'gps' | 'full' | 'multi';

export interface SystemSelectEntry {
  system: string;
  signal: string;
  enable: boolean;
}

export interface ModePreset {
  key: GenMode;
  text: string;
  center: number; // MHz
  rate: number; // Msps
  signals: SystemSelectEntry[];
}

export const MODE_PRESETS: ModePreset[] = [
  {
    key: 'fast',
    text: 'Fast - GPS + Galileo   (1573.42 / 6 Msps, ~3 min)',
    center: 1573.42,
    rate: 6.0,
    signals: [
      { system: 'GPS', signal: 'L1CA', enable: true },
      { system: 'Galileo', signal: 'E1', enable: true },
    ],
  },
  {
    key: 'gps',
    text: 'GPS only   (1568.286 / 18.48 Msps, ~6 min)',
    center: 1568.286,
    rate: 18.48,
    signals: [{ system: 'GPS', signal: 'L1CA', enable: true }],
  },
  {
    key: 'full',
    text: 'Full - GPS + Galileo + BeiDou   (1568.286 / 18.48 Msps, ~12 min)',
    center: 1568.286,
    rate: 18.48,
    signals: [
      { system: 'GPS', signal: 'L1CA', enable: true },
      { system: 'GPS', signal: 'L1C', enable: true },
      { system: 'Galileo', signal: 'E1', enable: true },
      { system: 'BDS', signal: 'B1I', enable: true },
    ],
  },
  {
    key: 'multi',
    text: 'Full - GPS + Galileo + BeiDou   (1568.286 / 18.48 Msps, ~12 min)',
    center: 1568.286,
    rate: 18.48,
    signals: [
      { system: 'GPS', signal: 'L1CA', enable: true },
      { system: 'GPS', signal: 'L1C', enable: true },
      { system: 'Galileo', signal: 'E1', enable: true },
      { system: 'BDS', signal: 'B1I', enable: true },
    ],
  },
];

export function presetFor(mode: GenMode): ModePreset {
  return MODE_PRESETS.find((m) => m.key === mode) ?? MODE_PRESETS[0];
}

export interface GenRequest {
  lat: number;
  lon: number;
  alt: number;
  duration: number; // seconds, >= 5
  utc: string; // 'yyyy-MM-dd HH:mm:ss'
  mode: GenMode;
  outName?: string;
}

export interface GenProgress {
  percent: number;
  elapsedMs: number;
}

export interface GenResult {
  ok: boolean;
  message: string;
  fileName?: string;
  sizeMB?: number;
  peak?: number;
  q11?: boolean;
}

export interface TagInfo {
  fLoMHz: number;
  fSMHz: number;
}

export interface TxStartRequest {
  file: string; // absolute path or name within signal dir
  gain: number;
  loop: boolean;
}

export interface TxStartedInfo {
  file: string;
  freqMHz: number;
  rateMsps: number;
  gain: number;
  loop: boolean;
}

export interface SignalFileEntry {
  name: string;
  sizeMB: number;
  modified: string;
  tag: TagInfo | null;
}

export interface RinexFileEntry {
  name: string;
  sizeMB: number;
  modified: string;
}

export interface UiSettings {
  lat: string;
  lon: string;
  alt: string;
  duration: string;
  utc: string;
  mode: GenMode;
  gain: number;
  loop: boolean;
}

export const DEFAULT_SETTINGS: UiSettings = {
  lat: '37.352721',
  lon: '-121.915773',
  alt: '20',
  duration: '60',
  utc: '',
  mode: 'fast',
  gain: 50,
  loop: true,
};

export interface AppState {
  generating: boolean;
  transmitting: boolean;
  rinex: string | null;
  txFile: string | null;
  txFreqMHz: number;
  txRateMsps: number;
  gain: number;
  loop: boolean;
  genProgress: GenProgress | null;
  genResult: GenResult | null;
  settings: UiSettings;
  logHistory: string[];
}
