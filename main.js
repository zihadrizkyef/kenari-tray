const { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

const BASE_URL = 'https://kenari.id';
const CONFIG_PATH = path.join(app.getPath('userData'), 'kenari-tray-config.json');
const REFRESH_MS = 5 * 60 * 1000;

let tray = null;
let popup = null;
let config = { apiKey: process.env.KENARI_API_KEY || '' };
let lastData = null;
let lastError = null;

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const saved = JSON.parse(raw);
    if (saved.apiKey) config.apiKey = saved.apiKey;
  } catch {}
}

function saveConfig() {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify({ apiKey: config.apiKey }, null, 2)); } catch {}
}

function fetchJson(pathname) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, BASE_URL);
    const req = https.get(url, {
      headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Invalid JSON')); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Request timeout')); });
    req.on('error', reject);
  });
}

async function refresh() {
  if (!config.apiKey) {
    lastError = 'KENARI_API_KEY belum diatur';
    lastData = null;
    updateTray();
    return;
  }
  try {
    const [quota, balance] = await Promise.all([
      fetchJson('/v1/account/quota'),
      fetchJson('/v1/account/balance'),
    ]);
    lastData = { quota, balance, fetchedAt: new Date().toISOString() };
    lastError = null;
  } catch (err) {
    lastError = err.message || String(err);
  }
  updateTray();
  if (popup && !popup.isDestroyed()) popup.webContents.send('data', payload());
}

function payload() {
  return { data: lastData, error: lastError, hasKey: !!config.apiKey };
}

// --- tray icon: hand-rolled 16x16 PNG (ring progress) ---
const zlib = require('zlib');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function drawIcon(frac) {
  const size = 16;
  const raw = Buffer.alloc(size * (1 + size * 4));
  // precompute ring pixels
  const cx = (size - 1) / 2, cy = (size - 1) / 2;
  const rOut = 7.4, rIn = 5.2, rDot = 2.0;
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      let r = 0, g = 0, b = 0, a = 0;
      if (d <= rDot) {
        r = 236; g = 236; b = 239; a = 255; // center dot
      } else if (d >= rIn && d <= rOut) {
        // angle from top, clockwise
        let ang = Math.atan2(dx, -dy); // 0 at top, clockwise positive
        if (ang < 0) ang += Math.PI * 2;
        const onArc = frac > 0 && ang <= frac * Math.PI * 2;
        if (onArc) {
          if (frac < 0.5) { r = 74; g = 222; b = 128; }
          else if (frac < 0.8) { r = 250; g = 204; b = 21; }
          else { r = 248; g = 113; b = 113; }
          a = 255;
        } else {
          r = 255; g = 255; b = 255; a = 64; // track
        }
      }
      const o = rowStart + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return nativeImage.createFromBuffer(png);
}

function overallFrac() {
  const w = lastData?.quota?.plan?.windows || {};
  // pick the most-used window fraction for the ring
  let max = 0;
  for (const key of ['five_hour', 'week', 'month']) {
    const f = w[key]?.used_frac;
    if (typeof f === 'number' && f > max) max = f;
  }
  return Math.min(1, max);
}

function updateTray() {
  if (!tray) return;
  const frac = overallFrac();
  tray.setImage(drawIcon(frac));
  let tip = 'Kenari';
  if (lastError) tip = `Kenari — ${lastError}`;
  else if (lastData) {
    const parts = [];
    const w = lastData.quota?.plan?.windows || {};
    if (w.month) parts.push(`Bulanan ${(w.month.used_frac * 100).toFixed(0)}%`);
    if (w.week) parts.push(`Mingguan ${(w.week.used_frac * 100).toFixed(0)}%`);
    if (w.five_hour) parts.push(`5 jam ${(w.five_hour.used_frac * 100).toFixed(0)}%`);
    tip = parts.length ? `Kenari — ${parts.join(' · ')}` : 'Kenari — OK';
  }
  tray.setToolTip(tip);
}

// --- popup window ---
function togglePopup() {
  if (popup && !popup.isDestroyed() && popup.isVisible()) {
    popup.hide();
    return;
  }
  showPopup();
}

function showPopup() {
  if (!popup || popup.isDestroyed()) {
    popup = new BrowserWindow({
      width: 340,
      height: 540,
      show: false,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      transparent: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    popup.loadFile('popup.html');
    popup.on('blur', () => popup.hide());
  }
  const trayBounds = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const wb = display.workArea;
  const winBounds = popup.getBounds();
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
  x = Math.max(wb.x + 8, Math.min(x, wb.x + wb.width - winBounds.width - 8));
  let y;
  if (trayBounds.y > wb.y + wb.height / 2) {
    y = Math.round(trayBounds.y - winBounds.height - 8); // taskbar at bottom
  } else {
    y = Math.round(trayBounds.y + trayBounds.height + 8); // taskbar at top
  }
  popup.setPosition(x, y, false);
  popup.show();
  popup.focus();
  popup.webContents.send('data', payload());
  refresh();
}

ipcMain.on('set-api-key', (_e, key) => {
  config.apiKey = (key || '').trim();
  saveConfig();
  refresh();
});
ipcMain.on('get-data', (e) => e.reply('data', payload()));
ipcMain.on('refresh', () => refresh());
ipcMain.on('hide', () => { if (popup && !popup.isDestroyed()) popup.hide(); });
ipcMain.on('open-dashboard', () => shell.openExternal('https://kenari.id/dashboard'));
ipcMain.on('quit', () => app.quit());

app.whenReady().then(() => {
  loadConfig();
  app.setLoginItemSettings({ openAtLogin: false });

  tray = new Tray(drawIcon(0));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Buka', click: showPopup },
    { label: 'Refresh', click: refresh },
    { type: 'separator' },
    { label: 'Keluar', click: () => app.quit() },
  ]));
  tray.on('click', togglePopup);
  tray.on('right-click', () => tray.popUpContextMenu());

  refresh();
  setInterval(refresh, REFRESH_MS);

  // Hide dock icon on macOS
  if (process.platform === 'darwin') app.dock.hide();
});

app.on('window-all-closed', (e) => e.preventDefault());
