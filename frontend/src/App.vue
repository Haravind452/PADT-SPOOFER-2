<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { io, type Socket } from 'socket.io-client';

type ModeKey = 'fast' | 'gps' | 'full' | 'multi';

interface ModePreset {
  key: ModeKey;
  text: string;
  center: number;
  rate: number;
}

interface RinexEntry {
  name: string;
  sizeMB: number;
  modified: string;
}

interface SignalEntry {
  name: string;
  sizeMB: number;
  modified: string;
  tag: { fLoMHz: number; fSMHz: number } | null;
}

interface GenProgress {
  percent: number;
  elapsedMs: number;
}

interface GenResult {
  ok: boolean;
  message: string;
  fileName?: string;
  sizeMB?: number;
  peak?: number;
  q11?: boolean;
}

interface AppState {
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
  settings: {
    lat: string;
    lon: string;
    alt: string;
    duration: string;
    utc: string;
    mode: ModeKey;
    gain: number;
    loop: boolean;
  };
  logHistory: string[];
}

const C_GREEN = '#2ecc71';
const C_RED = '#e74c3c';
const C_ORNG = '#f39c12';
const C_MUTE = '#9b9ba1';

const GAIN_MIN = -20;
const GAIN_MAX = 60;
const GAIN_STEP = 10;

function snapGain(v: number): number {
  if (!Number.isFinite(v)) return GAIN_MIN;
  const snapped = Math.round(v / GAIN_STEP) * GAIN_STEP;
  return Math.min(GAIN_MAX, Math.max(GAIN_MIN, snapped));
}

const socket: Socket = io();

const modes = ref<ModePreset[]>([]);

const lat = ref('37.352721');
const lon = ref('-121.915773');
const alt = ref('20');
const duration = ref('60');
const utc = ref('');
const mode = ref<ModeKey>('fast');

const txFileName = ref('');

const gain = ref(50);
const loop = ref(true);

const genBusy = ref(false);
const txBusy = ref(false);
const txStatus = ref('Idle');
const genStatusText = ref('Idle');
const genStatusColor = ref(C_MUTE);
const genPercent = ref(0);

const rinexLabel = ref('RINEX: BRDC00IGS_R_20262220000_01D_MN.rnx');
const rinexLabelColor = ref(C_MUTE);
const txParamLabel = ref('TX: -- MHz / -- Msps (from file tag)');
const downloading = ref(false);
const latestBtnText = ref('Get latest');

const logLines = ref<{ time: string; text: string }[]>([]);
const logEl = ref<HTMLElement | null>(null);

const snack = ref<{ show: boolean; text: string; color: string }>({ show: false, text: '', color: C_RED });

const rinexDialog = ref(false);
const txDialog = ref(false);
const rinexFiles = ref<RinexEntry[]>([]);
const txFiles = ref<SignalEntry[]>([]);
const rinexLoadError = ref(false);
const txLoadError = ref(false);
const uploadBusy = ref(false);

function showError(text: string): void {
  snack.value = { show: true, text, color: C_RED };
}

function fmtElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function splitLogLine(line: string): { time: string; text: string } {
  const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\] (.*)$/);
  if (m) return { time: m[1], text: m[2] };
  return { time: '', text: line };
}

function scrollLog(): void {
  void nextTick(() => {
    if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight;
  });
}

function applyState(s: AppState): void {
  genBusy.value = s.generating;
  txBusy.value = s.transmitting;
  txStatus.value = s.transmitting ? 'TRANSMITTING' : 'Idle';
  if (s.rinex) {
    rinexLabel.value = `RINEX: ${s.rinex}`;
    rinexLabelColor.value = C_MUTE;
  } else {
    rinexLabel.value = 'RINEX: (none - Get latest or Browse)';
    rinexLabelColor.value = C_ORNG;
  }
  if (s.txFile) {
    txFileName.value = s.txFile;
  }
  if (s.txFreqMHz > 0 && s.txRateMsps > 0) {
    txParamLabel.value = `TX: ${s.txFreqMHz} MHz / ${s.txRateMsps} Msps (from file tag)`;
  }
  gain.value = snapGain(s.gain);
  loop.value = s.loop;
  lat.value = s.settings.lat;
  lon.value = s.settings.lon;
  alt.value = s.settings.alt;
  duration.value = s.settings.duration;
  utc.value = s.settings.utc;
  mode.value = s.settings.mode;
  if (s.logHistory.length > 0) {
    logLines.value = s.logHistory.map(splitLogLine);
  }
  if (s.genProgress) {
    genPercent.value = s.genProgress.percent;
    if (s.generating) {
      genStatusText.value = `Generating...   ${fmtElapsed(s.genProgress.elapsedMs)}   ${s.genProgress.percent}%`;
      genStatusColor.value = C_ORNG;
    }
  }
  if (s.genResult) {
    const r = s.genResult;
    if (r.ok) {
      genStatusText.value = r.message;
      genStatusColor.value = C_GREEN;
      if (r.fileName) txFileName.value = r.fileName;
    } else if (r.fileName) {
      genStatusText.value = r.message;
      genStatusColor.value = C_RED;
    }
  }
}

onMounted(() => {
  socket.on('state:sync', applyState);
  socket.on('log:append', (p: { line: string }) => {
    logLines.value.push(splitLogLine(p.line));
    if (logLines.value.length > 500) logLines.value.splice(0, logLines.value.length - 500);
    scrollLog();
  });
  socket.on('gen:progress', (p: GenProgress) => {
    genPercent.value = p.percent;
    if (genBusy.value) {
      genStatusText.value = `Generating...   ${fmtElapsed(p.elapsedMs)}   ${p.percent}%`;
      genStatusColor.value = C_ORNG;
    }
  });
  socket.on('gen:done', (r: GenResult) => {
    genBusy.value = false;
    if (r.ok) {
      genStatusText.value = r.message;
      genStatusColor.value = C_GREEN;
      if (r.fileName) txFileName.value = r.fileName;
    } else {
      genStatusText.value = r.fileName ? r.message : 'FAILED';
      genStatusColor.value = C_RED;
    }
  });
  socket.on('tx:started', (info: { file: string; freqMHz: number; rateMsps: number; loop: boolean }) => {
    txBusy.value = true;
    txStatus.value = 'TRANSMITTING';
    txFileName.value = info.file.split(/[\\/]/).pop() ?? info.file;
    txParamLabel.value = `TX: ${info.freqMHz} MHz / ${info.rateMsps} Msps (from file tag)`;
  });
  socket.on('tx:stopped', () => {
    txBusy.value = false;
    txStatus.value = 'Idle';
  });
  socket.on('rinex:ready', (p: { fileName?: string; utc?: string | null }) => {
    downloading.value = false;
    latestBtnText.value = 'Get latest';
    if (p.fileName) {
      rinexLabel.value = `RINEX: ${p.fileName}`;
      rinexLabelColor.value = C_MUTE;
    }
    if (p.utc) utc.value = p.utc;
  });
  socket.on('rinex:status', (p: { message?: string }) => {
    downloading.value = false;
    latestBtnText.value = 'Get latest';
    if (p.message) showError(p.message);
  });
  void fetch('/api/modes')
    .then((r) => r.json())
    .then((d) => {
      modes.value = (d.modes as ModePreset[]).filter((m) => m.key !== 'multi');
    })
    .catch(() => showError('Backend unreachable.'));
  socket.emit('rinex:match', {}, (r: { error?: string; utc?: string | null }) => {
    if (!r.error && r.utc) utc.value = r.utc;
  });
});

onBeforeUnmount(() => {
  socket.off('state:sync');
  socket.off('log:append');
  socket.off('gen:progress');
  socket.off('gen:done');
  socket.off('tx:started');
  socket.off('tx:stopped');
  socket.off('rinex:ready');
  socket.off('rinex:status');
  socket.disconnect();
});

watch(logLines, () => scrollLog());

const genControlsDisabled = computed(() => genBusy.value || txBusy.value);
const txControlsDisabled = computed(() => txBusy.value);

function emitAck<T>(event: string, payload: unknown, cb: (r: T) => void): void {
  socket.emit(event, payload, cb as never);
}

function onGenerate(): void {
  const payload = {
    lat: Number(lat.value),
    lon: Number(lon.value),
    alt: Number(alt.value),
    duration: Number(duration.value),
    utc: utc.value,
    mode: mode.value,
  };
  genBusy.value = true;
  genStatusText.value = 'Generating...';
  genStatusColor.value = C_ORNG;
  genPercent.value = 0;
  emitAck<{ error?: string }>('gen:start', payload, (r) => {
    if (r.error) {
      genBusy.value = false;
      genStatusText.value = 'Idle';
      genStatusColor.value = C_MUTE;
      showError(r.error);
    }
  });
  void saveSettings();
}

function onMatchUtc(): void {
  emitAck<{ error?: string; utc?: string | null }>('rinex:match', {}, (r) => {
    if (r.error) showError(r.error);
    if (r.utc) utc.value = r.utc;
  });
}

async function openRinexDialog(): Promise<void> {
  rinexDialog.value = true;
  await loadRinexList();
}

async function loadRinexList(): Promise<void> {
  try {
    const d = await (await fetch('/api/rinex/list')).json();
    rinexFiles.value = (d.files as RinexEntry[]) ?? [];
    rinexLoadError.value = false;
  } catch {
    rinexLoadError.value = true;
    showError('Backend unreachable.');
  }
}

function selectRinex(name: string): void {
  emitAck<{ error?: string; utc?: string | null }>('rinex:select', { name }, (r) => {
    if (r.error) {
      showError(r.error);
      return;
    }
    rinexLabel.value = `RINEX: ${name}`;
    rinexLabelColor.value = C_MUTE;
    if (r.utc) utc.value = r.utc;
    rinexDialog.value = false;
  });
}

function onGetLatest(): void {
  downloading.value = true;
  latestBtnText.value = 'Downloading...';
  emitAck<{ error?: string }>('rinex:latest', {}, (r) => {
    if (r.error) {
      downloading.value = false;
      latestBtnText.value = 'Get latest';
      showError(r.error);
    }
  });
}

async function openTxDialog(): Promise<void> {
  txDialog.value = true;
  await loadTxList();
}

async function loadTxList(): Promise<void> {
  try {
    const d = await (await fetch('/api/signal/list')).json();
    txFiles.value = (d.files as SignalEntry[]) ?? [];
    txLoadError.value = false;
  } catch {
    txLoadError.value = true;
    showError('Backend unreachable.');
  }
}

function selectTx(name: string): void {
  emitAck<{ error?: string; tag?: { fLoMHz: number; fSMHz: number } }>('signal:select', { name }, (r) => {
    if (r.error) {
      showError(r.error);
      return;
    }
    txFileName.value = name;
    if (r.tag) {
      txParamLabel.value = `TX: ${r.tag.fLoMHz} MHz / ${r.tag.fSMHz} Msps (from file tag)`;
    }
    txDialog.value = false;
  });
}

function onStartTx(): void {
  const payload = {
    file: txFileName.value || null,
    gain: gain.value,
    loop: loop.value,
  };
  emitAck<{ error?: string }>('tx:start', payload, (r) => {
    if (r.error) showError(r.error);
  });
}

function onStopTx(): void {
  void socket.emit('tx:stop');
}

function onGainChange(v: number): void {
  gain.value = snapGain(v);
  socket.emit('tx:gain', { gain: gain.value });
}

function onGainCommit(): void {
  gain.value = snapGain(gain.value);
  void saveSettings();
}

async function saveSettings(): Promise<void> {
  socket.emit('settings:save', {
    lat: lat.value,
    lon: lon.value,
    alt: alt.value,
    duration: duration.value,
    utc: utc.value,
    mode: mode.value,
    gain: gain.value,
    loop: loop.value,
  });
}

async function onUpload(kind: 'rinex' | 'signal', file: File | null): Promise<void> {
  if (!file) return;
  uploadBusy.value = true;
  const form = new FormData();
  form.append('file', file);
  const url = kind === 'rinex' ? '/api/upload/rinex' : '/api/upload/signal';
  try {
    const r = await fetch(url, { method: 'POST', body: form });
    const d = (await r.json()) as { error?: string; name?: string; utc?: string | null };
    if (!r.ok || d.error) {
      showError(d.error ?? 'Upload failed.');
      return;
    }
    if (kind === 'rinex') {
      rinexLabel.value = `RINEX: ${d.name}`;
      rinexLabelColor.value = C_MUTE;
      if (d.utc) utc.value = d.utc;
      await loadRinexList();
    } else {
      txFileName.value = d.name ?? '';
      await loadTxList();
    }
  } catch {
    showError('Upload failed.');
  } finally {
    uploadBusy.value = false;
  }
}
</script>

<template>
  <v-app>
    <v-main class="main-wrapper">
      <div class="app">
        <!-- HEADER -->
        <header class="header">
          <h1 class="title">bladeRF GNSS Studio</h1>
          <div class="subtitle">
            Coordinates &rarr; SC16 Q11 IF file &rarr; transmit&nbsp;&nbsp; Lab / shielded use only.
          </div>
        </header>

        <!-- MAIN -->
        <main class="main">
          <!-- ================= GENERATE ================= -->
          <section class="panel">
            <div class="section-title">1 - GENERATE</div>

            <div class="form-row">
              <label class="form-label">Latitude</label>
              <input v-model="lat" type="text" :disabled="genControlsDisabled" />
            </div>

            <div class="form-row">
              <label class="form-label">Longitude</label>
              <input v-model="lon" type="text" :disabled="genControlsDisabled" />
            </div>

            <div class="form-row">
              <label class="form-label">Altitude m</label>
              <input v-model="alt" type="text" :disabled="genControlsDisabled" />
            </div>

            <div class="radio-group">
              <label v-for="m in modes" :key="m.key" class="radio-row">
                <input v-model="mode" type="radio" name="mode" :value="m.key" :disabled="genControlsDisabled" />
                <span>{{ m.text }}</span>
              </label>
            </div>

            <div class="time-row">
              <label class="form-label">UTC time</label>
              <input v-model="utc" type="text" placeholder="yyyy-MM-dd HH:mm:ss" :disabled="genControlsDisabled" />
              <button class="match-btn" :disabled="genControlsDisabled" @click="onMatchUtc">Match RINEX</button>
            </div>

            <div class="form-row">
              <label class="form-label">Duration s</label>
              <input v-model="duration" type="text" :disabled="genControlsDisabled" />
            </div>

            <div class="rinex-text" :style="{ color: rinexLabelColor }" :title="rinexLabel">{{ rinexLabel }}</div>

            <div class="file-row">
              <label class="form-label">Ephemeris</label>
              <div class="file-buttons">
                <button class="browse-btn" :disabled="genControlsDisabled" @click="openRinexDialog">Browse</button>
                <button
                  class="latest-btn"
                  :disabled="genControlsDisabled || downloading"
                  @click="onGetLatest"
                >
                  {{ latestBtnText }}
                </button>
              </div>
            </div>

            <button class="generate-btn" :disabled="genBusy || txBusy" @click="onGenerate">
              GENERATE Q11 FILE
            </button>

            <div class="progress">
              <div class="progress-value" :style="{ width: genPercent + '%' }"></div>
            </div>

            <div class="status" :style="{ color: genStatusColor }">{{ genStatusText }}</div>
          </section>

          <!-- ================= TRANSMIT ================= -->
          <section class="panel">
            <div class="section-title">2 - TRANSMIT</div>

            <div class="tx-file">
              <span class="tx-label">TX file</span>
              <input v-model="txFileName" type="text" placeholder="(none)" readonly :disabled="txControlsDisabled" />
              <button class="browse-btn" :disabled="txControlsDisabled" @click="openTxDialog">Browse</button>
            </div>

            <div class="tx-info">{{ txParamLabel }}</div>

            <div class="gain-container">
              <div class="gain-header">
                <span class="gain-label">Gain</span>
                <span class="gain-value">{{ gain }} dB</span>
              </div>
              <input
                v-model.number="gain"
                class="slider"
                type="range"
                min="-20"
                max="60"
                step="10"
                @input="onGainChange(Number(($event.target as HTMLInputElement).value))"
                @change="onGainCommit"
              />
              <div class="ticks">
                <span v-for="i in 9" :key="i" class="tick"></span>
              </div>
            </div>

            <label class="loop">
              <input v-model="loop" type="checkbox" />
              <span>Loop (repeat forever)</span>
            </label>

            <div class="tx-buttons">
              <button class="start-btn" :disabled="txBusy" @click="onStartTx">START TX</button>
              <button class="stop-btn" :disabled="!txBusy" @click="onStopTx">STOP</button>
            </div>

            <div class="tx-status" :style="{ color: txBusy ? '#ef493e' : '#bdbdc2' }">{{ txStatus }}</div>

            <div class="tip">Tip: cold-start the receiver after START, wait ~45&ndash;60 s for a fix.</div>
          </section>
        </main>

        <!-- LOG / CONSOLE -->
        <section class="logs" ref="logEl">
          <div v-for="(l, i) in logLines" :key="i" class="log">
            <span v-if="l.time" class="log-time">[{{ l.time }}]</span>{{ l.text }}
          </div>
        </section>
      </div>

      <!-- RINEX browser -->
      <v-dialog v-model="rinexDialog" max-width="560">
        <v-card class="dialog-card">
          <v-card-title class="dialog-title">RINEX files on server</v-card-title>
          <v-card-text>
            <v-file-input
              label="Upload RINEX from this machine (.rnx)"
              variant="outlined"
              density="compact"
              accept=".rnx"
              :loading="uploadBusy"
              class="mb-3"
              @update:model-value="(f: File | File[] | null) => onUpload('rinex', Array.isArray(f) ? (f[0] ?? null) : f)"
            />
            <v-list v-if="rinexFiles.length > 0" class="file-list" density="compact">
              <v-list-item v-for="f in rinexFiles" :key="f.name" @click="selectRinex(f.name)">
                <template #prepend>
                  <v-icon size="small" color="#18aee8">mdi-file-table-outline</v-icon>
                </template>
                <v-list-item-title class="file-name">{{ f.name }}</v-list-item-title>
                <v-list-item-subtitle class="file-sub">
                  {{ f.sizeMB }} MB - {{ new Date(f.modified).toLocaleString() }}
                </v-list-item-subtitle>
              </v-list-item>
            </v-list>
            <div v-else-if="rinexLoadError" class="file-empty file-error">
              Backend unreachable - check that the server is running, then close and reopen this dialog.
            </div>
            <div v-else class="file-empty">No RINEX files on the server yet.</div>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn @click="rinexDialog = false">Close</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <!-- TX file browser -->
      <v-dialog v-model="txDialog" max-width="560">
        <v-card class="dialog-card">
          <v-card-title class="dialog-title">TX files on server</v-card-title>
          <v-card-text>
            <v-file-input
              label="Upload .bin from this machine"
              variant="outlined"
              density="compact"
              accept=".bin"
              :loading="uploadBusy"
              class="mb-3"
              @update:model-value="(f: File | File[] | null) => onUpload('signal', Array.isArray(f) ? (f[0] ?? null) : f)"
            />
            <v-list v-if="txFiles.length > 0" class="file-list" density="compact">
              <v-list-item v-for="f in txFiles" :key="f.name" @click="selectTx(f.name)">
                <template #prepend>
                  <v-icon size="small" color="#2df083">mdi-sine-wave</v-icon>
                </template>
                <v-list-item-title class="file-name">{{ f.name }}</v-list-item-title>
                <v-list-item-subtitle class="file-sub">
                  {{ f.sizeMB }} MB
                  <template v-if="f.tag">- {{ f.tag.fLoMHz }} MHz / {{ f.tag.fSMHz }} Msps</template>
                </v-list-item-subtitle>
              </v-list-item>
            </v-list>
            <div v-else-if="txLoadError" class="file-empty file-error">
              Backend unreachable - check that the server is running, then close and reopen this dialog.
            </div>
            <div v-else class="file-empty">No .bin files on the server yet.</div>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn @click="txDialog = false">Close</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <v-snackbar v-model="snack.show" :timeout="6000" :color="snack.color" location="bottom">
        <span class="snack-text">{{ snack.text }}</span>
        <template #actions>
          <v-btn variant="text" text-color="white" @click="snack.show = false">OK</v-btn>
        </template>
      </v-snackbar>
    </v-main>
  </v-app>
</template>

<style scoped>
* {
  box-sizing: border-box;
}

.main-wrapper {
  padding: 0;
}

.app {
  width: 100%;
  min-height: 100vh;
  height: auto;
  display: flex;
  flex-direction: column;
  background: #101014;
  color: #e8e8e8;
  font-family: Arial, Helvetica, sans-serif;
}

/* ---------------- HEADER ---------------- */
.header {
  padding: 28px 26px 18px;
  flex-shrink: 0;
}

.title {
  margin: 0;
  color: #18aee8;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 0.2px;
}

.subtitle {
  margin-top: 8px;
  color: #8d8d94;
  font-size: 13px;
}

/* ---------------- MAIN ---------------- */
.main {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  padding: 0 17px 12px;
}

.panel {
  background: #1c1c21;
  min-width: 0;
  padding: 18px 24px;
  display: flex;
  flex-direction: column;
}

.section-title {
  color: #18aee8;
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 20px;
}

/* ---------------- FORM ---------------- */
.form-row {
  display: grid;
  grid-template-columns: 105px 1fr;
  align-items: center;
  margin-bottom: 8px;
}

.form-label {
  color: #bdbdc3;
  font-size: 13px;
}

input[type='text'] {
  width: 100%;
  height: 27px;
  border: 1px solid #4d4d52;
  background: #27272c;
  color: #e6e6e6;
  padding: 4px 8px;
  font-size: 13px;
  outline: none;
}

input[type='text']:focus {
  border-color: #22aee6;
}

input:disabled {
  opacity: 0.55;
}

/* ---------------- RADIO ---------------- */
.radio-group {
  margin: 8px 0 15px 105px;
}

.radio-row {
  display: flex;
  align-items: center;
  min-height: 29px;
  color: #c6c6ca;
  font-size: 13px;
  cursor: pointer;
}

.radio-row input {
  margin: 0 8px 0 0;
  accent-color: #189fe0;
}

/* ---------------- TIME ROW ---------------- */
.time-row {
  display: grid;
  grid-template-columns: 105px 1fr auto;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.match-btn {
  height: 29px;
  padding: 0 15px;
  border: 1px solid #4b4b50;
  background: #2b2b30;
  color: #c9c9cc;
  cursor: pointer;
  font-size: 12px;
}

.match-btn:hover,
.browse-btn:hover,
.latest-btn:hover {
  background: #36363b;
}

/* ---------------- RINEX ---------------- */
.rinex-text {
  margin: 3px 0 9px 0;
  color: #88888f;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-row {
  display: grid;
  grid-template-columns: 105px 1fr;
  align-items: center;
  margin-bottom: 10px;
}

.file-buttons {
  display: flex;
  gap: 5px;
}

.browse-btn,
.latest-btn {
  height: 30px;
  min-width: 105px;
  border: 1px solid #44444a;
  background: #2b2b30;
  color: #c6c6c9;
  cursor: pointer;
  font-size: 12px;
}

/* ---------------- GENERATE ---------------- */
.generate-btn {
  width: 100%;
  height: 47px;
  border: none;
  background: #21abe5;
  color: #111;
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
  margin-top: 2px;
}

.generate-btn:hover {
  background: #35b9ed;
}

.generate-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.progress {
  width: 100%;
  height: 14px;
  margin-top: 6px;
  background: #d9d9d9;
  border: 1px solid #777;
  overflow: hidden;
}

.progress-value {
  width: 0%;
  height: 100%;
  background: #1eabe4;
  transition: width 0.3s ease;
}

/* ---------------- STATUS ---------------- */
.status {
  margin-top: 8px;
  color: #9b9ba1;
  font-size: 12px;
}

/* ---------------- TRANSMIT ---------------- */
.tx-file {
  display: grid;
  grid-template-columns: 55px 1fr 88px;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.tx-label {
  color: #bdbdc3;
  font-size: 13px;
}

.tx-info {
  margin: 5px 0 16px 110px;
  color: #1aabe7;
  font-size: 16px;
  font-weight: 700;
}

/* ---------------- GAIN ---------------- */
.gain-container {
  margin: 0 8px 14px 0;
}

.gain-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}

.gain-label {
  color: #bdbdc3;
  font-size: 13px;
}

.gain-value {
  color: #1aabe7;
  font-size: 20px;
  font-weight: 700;
  margin-right: 52%;
}

.slider {
  width: 100%;
  height: 5px;
  appearance: none;
  background: #e0e0e0;
  outline: none;
  cursor: pointer;
}

.slider::-webkit-slider-thumb {
  appearance: none;
  width: 12px;
  height: 16px;
  background: #118bd0;
  cursor: pointer;
}

.slider::-moz-range-thumb {
  width: 12px;
  height: 16px;
  border: none;
  background: #118bd0;
  cursor: pointer;
}

.ticks {
  display: flex;
  justify-content: space-between;
  margin: 5px 6px 0;
}

.tick {
  width: 1px;
  height: 8px;
  background: #ffffff;
}

/* ---------------- CHECKBOX ---------------- */
.loop {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 10px;
  color: #c4c4c8;
  font-size: 12px;
  cursor: pointer;
}

.loop input {
  margin: 0;
  accent-color: #168fd0;
}

/* ---------------- TX BUTTONS ---------------- */
.tx-buttons {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.start-btn,
.stop-btn {
  height: 53px;
  border: none;
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
}

.start-btn {
  background: #2df083;
  color: #101010;
}

.start-btn:hover {
  background: #45f493;
}

.stop-btn {
  background: #ef493e;
  color: #171717;
}

.stop-btn:hover {
  background: #f35b51;
}

.start-btn:disabled,
.stop-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.tx-status {
  margin-top: 9px;
  color: #bdbdc2;
  font-size: 13px;
  font-weight: 700;
}

.tip {
  margin-top: 17px;
  color: #77777e;
  font-size: 11px;
}

/* ---------------- LOG PANEL ---------------- */
.logs {
  height: 204px;
  flex-shrink: 0;
  margin: 0 15px 12px;
  border: 1px solid #4a4a4e;
  background: #08090a;
  overflow-y: auto;
  padding: 6px 4px;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.35;
}

.log {
  color: #55d278;
  white-space: pre-wrap;
  word-break: break-word;
}

.log-time {
  color: #62e27c;
}

/* ---------------- DIALOGS ---------------- */
.dialog-card {
  background: #1c1c21 !important;
}

.dialog-title {
  color: #18aee8;
  font-weight: 700;
}

.file-list {
  max-height: 320px;
  overflow-y: auto;
  background: #101014;
  border: 1px solid #4d4d52;
  border-radius: 4px;
}

.file-name {
  font-size: 12px;
  color: #e6e6e6;
  font-family: Consolas, monospace;
}

.file-sub {
  font-size: 11px;
  color: #8d8d94;
}

.file-empty {
  color: #8d8d94;
  font-size: 12px;
  padding: 12px 0;
}

.file-error {
  color: #ef493e;
}

.snack-text {
  white-space: pre-line;
  font-size: 13px;
}

/* ---------------- RESPONSIVE ---------------- */
@media (max-width: 900px) {
  .app {
    height: auto;
    min-height: 100vh;
  }

  .main {
    grid-template-columns: 1fr;
  }

  .logs {
    height: 180px;
  }
}
</style>