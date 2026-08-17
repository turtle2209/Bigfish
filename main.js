'use strict';

/**
 * Bigfish — Electron desktop shell for DeepSeek Harness.
 *
 * Architecture:
 *   1. Find a free localhost port.
 *   2. Spawn the bundled `@deepseek-ai/dsh` CLI in "web" profile as a child
 *      process (this is the same backend that `dsh web` runs).
 *   3. Wait until the backend responds on 127.0.0.1:<port>.
 *   4. Open a native BrowserWindow pointing at that local URL.
 *
 * Desktop-product extras (on top of the plain web shell):
 *   - system tray + global shortcut to summon the window
 *   - minimize-to-tray (closing the window keeps the app alive)
 *   - completion notifications (heuristic: backend writes then goes idle)
 *   - desktop pet (鲸鱼娘): transparent floating window, draggable,
 *     碰墙折返的散步/跑步、点击互动、随机说话与小动作、好感度条
 *   - 好感度 & 兑换屋：按真实 token 消耗累积好感/等级，右键鲸鱼娘把 token
 *     换成 💴 买食物喂食
 *   - plugin ecosystem: bundled pnpm installs/removes DSH plugins in the web
 *     profile, and a native "插件市场" window browses/installs/uninstalls them
 *   - launch at login, and a Windows "Open with Bigfish" context menu
 */

const {
  app, BrowserWindow, shell, dialog, Tray, Menu, globalShortcut,
  nativeImage, Notification, ipcMain, screen,
} = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');

const APP_NAME = 'Bigfish';
const HOST = '127.0.0.1';
const READY_TIMEOUT_MS = 90 * 1000;
const IDLE_NOTIFY_MS = 30 * 1000; // backend quiet for this long after activity => "done"

// 测试/多实例：允许用环境变量指定 userData（避免 --user-data-dir 经 cmd 转发被改坏）
if (process.env.BIGFISH_USER_DATA && String(process.env.BIGFISH_USER_DATA).trim() !== '') {
  try { app.setPath('userData', String(process.env.BIGFISH_USER_DATA).trim()); } catch { /* ignore */ }
}

// 检查更新：从 latest.json 读取最新版本（方法二，启动时查一次）
// jsdelivr 优先（国内可访问），raw.githubusercontent 兜底
const UPDATE_JSON_URLS = [
  'https://cdn.jsdelivr.net/gh/turtle2209/Bigfish@main/latest.json',
  'https://raw.githubusercontent.com/turtle2209/Bigfish/main/latest.json',
];

/** @type {import('node:child_process').ChildProcess | null} */
let dshProcess = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let petWindow = null;
/** @type {BrowserWindow | null} */
let welcomeWindow = null;
/** @type {Tray | null} */
let tray = null;
/** @type {number | null} */
let port = null;
let quitting = false;
let completionWatcherTimer = null;
let lastBusyAt = 0;
let notifiedForCycle = false;

// ---------------------------------------------------------------------------
// Settings (persisted to userData/settings.json)
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  notifyOnComplete: true,
  launchAtLogin: false,
  petEnabled: true,
  onboardingDone: false,
  mode: 'whale',        // 'whale' 鲸鱼模式（桌宠+背景图） | 'focus' 专注模式（无桌宠、纯色背景）
  modeChosen: false,    // 是否已弹过模式选择
  lastModeVersion: '',  // 上次选择模式时的版本号（更新后重新弹窗）
};
let settings = { ...DEFAULT_SETTINGS };

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('[bigfish] failed to save settings:', err);
  }
}

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, HOST, () => {
      const addr = srv.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(p));
    });
  });
}

function dshBinPath() {
  if (app.isPackaged) {
    // The production-only dsh node_modules are bundled via extraResources.
    return path.join(process.resourcesPath, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  }
  return path.join(app.getAppPath(), 'dsh-bundle', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

/** Directory of bundled skills shipped with the app (loaded via DSH_BUNDLED_SKILL_DIR). */
function bundledSkillDir() {
  return path.join(app.getAppPath(), 'bundled-skills');
}

function resolveRuntime() {
  const bin = dshBinPath();
  const env = { ...process.env, DSH_BUNDLED_SKILL_DIR: bundledSkillDir() };
  if (!app.isPackaged) {
    return { command: process.env.DSH_NODE || 'node', args: [bin], env };
  }
  const nodeBin = process.platform === 'win32' ? 'node.exe' : 'node';
  const nodeExe = path.join(process.resourcesPath, 'node-runtime', nodeBin);
  return { command: nodeExe, args: [bin], env };
}

function waitForReady(p, timeoutMs = READY_TIMEOUT_MS) {
  const base = `http://${HOST}:${p}`;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(`${base}/`, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else retry();
      });
      req.once('error', retry);
      req.setTimeout(3000, () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for the backend at ${base}`));
        return;
      }
      setTimeout(attempt, 500);
    };
    attempt();
  });
}

/** Kill any leftover backend processes from a previous session (crash / force quit). */
function cleanupStaleDsh() {
  try {
    if (process.platform === 'win32') {
      const script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*dsh/lib/bin.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
      // -WindowStyle Hidden：彻底不弹 PowerShell 黑窗
      spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], { stdio: 'ignore', windowsHide: true });
    } else {
      spawn('pkill', ['-f', 'dsh/lib/bin.js'], { stdio: 'ignore' });
    }
  } catch { /* best effort */ }
}

async function startDsh() {
  cleanupStaleDsh();
  // 先清理坏 bundle（防止上次误写入 github:xxx 导致后端启动崩）
  sanitizeProfileBundles();
  await new Promise((r) => setTimeout(r, 1500)); // 给清理留一点时间
  port = await findFreePort();
  const rt = resolveRuntime();
  const args = [...rt.args, '--profile', 'web', '--host', HOST, '--port', String(port)];
  console.log(`[bigfish] starting backend on http://${HOST}:${port}`);

  // 后端日志写文件，便于排查黑屏/启动失败；打不开时降级为 inherit，不让整个后端崩
  let logStream = null;
  try {
    const logPath = path.join(app.getPath('userData'), 'bigfish.log');
    logStream = fs.createWriteStream(logPath, { flags: 'a' });
    await new Promise((resolve) => {
      if (logStream.fd !== null) { resolve(); return; }
      logStream.once('open', resolve);
      logStream.once('error', () => { logStream = null; resolve(); });
    });
    if (logStream && logStream.fd !== null) {
      logStream.write(`\n\n===== ${new Date().toISOString()} start backend :${port} =====\n`);
    } else {
      logStream = null;
    }
  } catch { logStream = null; /* 日志写不了就算了 */ }

  const stdioOut = logStream || 'inherit';
  dshProcess = spawn(rt.command, args, {
    env: rt.env,
    stdio: ['ignore', stdioOut, stdioOut],
    windowsHide: true,
  });
  dshProcess.once('error', (err) => console.error('[bigfish] failed to spawn backend:', err));
  await waitForReady(port);
}

function stopDsh() {
  const child = dshProcess;
  dshProcess = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
    }
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
function notify(title, body) {
  if (!Notification.isSupported()) return;
  try {
    new Notification({ title, body, icon: appIconPath() }).show();
  } catch (err) {
    console.error('[bigfish] notification failed:', err);
  }
}

const PET_QUOTES = [
  // 人设·打招呼
  '我是深海里的鲸鱼公主，很高兴见到你~',
  '欢迎回来，我的小伙伴！',
  '鲸鱼公主来啦，今天也要一起加油哦！',
  '深海那么大，但我只想陪你~',
  // 人设·撒娇/互动
  '哼，都不理我，我要吐泡泡了~',
  '抱抱我嘛，我可是会喷水的公主！',
  '你忙的时候，我会乖乖在旁边看着你~',
  '我的尾巴会发光，但只有你才看得到哦~',
  // 趣味·小知识（鲸鱼相关）
  '小知识：蓝鲸的心跳每分钟只有 6 次哦~',
  '你知道吗？鲸鱼其实是哺乳动物，不是鱼！',
  '鲸鱼唱歌能传 1600 公里远，我的歌声呢~',
  '座头鲸会跳出海面，像是在跳芭蕾~',
  '小知识：抹香鲸可以潜水 90 分钟不上来！',
  // 趣味·日常生活
  '要不要我帮你把今天的任务列个清单？',
  '查资料、写报告、做 PPT，说一声就行~',
  '记得喝口水休息一下，别太累啦！',
  '作业写完记得检查一遍哦~',
  // 加油打气
  '今天也要元气满满！',
  '你已经很棒了，剩下的事交给我！',
  '别怕麻烦，我一直都在~',
];

function petSay(msg) {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet-say', msg);
  }
}

/** 待机时随机表演一段小动作（看书/星星眼/惊吓/开心），随后回到待机。 */
function playIdleVariant() {
  if (!petWindow || petWindow.isDestroyed() || petState !== 'idle') return;
  const variants = ['read', 'starry', 'scared', 'happy'];
  const v = variants[Math.floor(Math.random() * variants.length)];
  setPetState(v);
  setTimeout(() => {
    if (petState === v) setPetState('idle');
  }, 2400);
}

function schedulePetChatter() {
  clearTimeout(chatterTimer);
  chatterTimer = setTimeout(() => {
    if (petWindow && !petWindow.isDestroyed() && petState === 'idle') {
      // 40% 概率先表演一段小动作，再说话
      if (Math.random() < 0.4) playIdleVariant();
      petSay(PET_QUOTES[Math.floor(Math.random() * PET_QUOTES.length)]);
    }
    schedulePetChatter();
  }, 90000); // 固定 1.5 分钟说一句
}

function uninstall() {
  if (!app.isPackaged) {
    dialog.showMessageBox({ type: 'info', title: APP_NAME, message: '卸载功能只在安装版可用', detail: '请安装打包好的 Bigfish 后再使用卸载。' });
    return;
  }
  const uninstaller = path.join(path.dirname(process.execPath), 'Uninstall Bigfish.exe');
  if (fs.existsSync(uninstaller)) {
    quitting = true;
    spawn(uninstaller, [], { detached: true, stdio: 'ignore' });
    setTimeout(() => app.quit(), 800);
  } else {
    shell.openExternal('ms-settings:appsfeatures');
  }
}

// ---------------------------------------------------------------------------
// 检查更新（方法二）：启动时拉取 latest.json，发现新版本就提示下载
// ---------------------------------------------------------------------------
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function checkForUpdates() {
  if (!app.isPackaged) return; // 开发模式不检查
  // 依次尝试多个镜像源（jsdelivr → raw.githubusercontent）
  const tryUrl = (url, onDone) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        onDone(null);
        return;
      }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => onDone(body));
    });
    req.on('error', () => onDone(null));
    req.setTimeout(10000, () => { req.destroy(); onDone(null); });
  };
  let idx = 0;
  const next = (body) => {
    if (body) {
      try {
        const info = JSON.parse(body);
        const latest = String(info.version || '');
        const current = app.getVersion();
        if (latest && compareVersions(latest, current) > 0) {
          const url = (info.urls && info.urls[process.platform]) || info.url;
          const choice = dialog.showMessageBoxSync({
            type: 'info',
            title: APP_NAME,
            message: `发现新版本 v${latest}`,
            detail: info.note || '有新版本可用，是否去下载？',
            buttons: ['去下载', '以后再说'],
            defaultId: 0,
          });
          if (choice === 0 && url) shell.openExternal(url);
        }
        return;
      } catch { /* JSON 解析失败就忽略 */ }
    }
    idx++;
    if (idx < UPDATE_JSON_URLS.length) tryUrl(UPDATE_JSON_URLS[idx], next);
  };
  tryUrl(UPDATE_JSON_URLS[0], next);
}

// Heuristic "task completed" detector: watch DSH_HOME (excluding the static
// profiles/ tree) for writes; after a burst of activity followed by idle, notify.
function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');
}

// ---------------------------------------------------------------------------
// Onboarding wizard
// ---------------------------------------------------------------------------
function createWelcomeWindow() {
  if (welcomeWindow && !welcomeWindow.isDestroyed()) {
    welcomeWindow.show();
    welcomeWindow.focus();
    return;
  }
  welcomeWindow = new BrowserWindow({
    width: 520,
    height: 660,
    parent: mainWindow || undefined,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Bigfish 新手向导',
    autoHideMenuBar: true,
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'welcome-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  welcomeWindow.once('ready-to-show', () => {
    if (welcomeWindow && !welcomeWindow.isDestroyed()) {
      welcomeWindow.show();
      welcomeWindow.focus();
    }
  });
  welcomeWindow.loadFile(path.join(__dirname, 'welcome.html'));
  welcomeWindow.on('closed', () => { welcomeWindow = null; });
}

function latestMtime(dir, skipNames, out) {
  out = out || { t: 0 };
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (skipNames && skipNames.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      latestMtime(full, skipNames, out);
    } else if (e.isFile()) {
      try {
        const t = fs.statSync(full).mtimeMs;
        if (t > out.t) out.t = t;
      } catch { /* ignore */ }
    }
  }
  return out;
}

function startCompletionWatcher() {
  stopCompletionWatcher();
  const skip = new Set(['profiles', 'node_modules']);
  completionWatcherTimer = setInterval(() => {
    if (!settings.notifyOnComplete) return;
    const { t } = latestMtime(dshHome(), skip);
    const now = Date.now();
    if (t > lastBusyAt + 2000 && now - t < 2000) {
      // fresh write => busy
      lastBusyAt = now;
      notifiedForCycle = false;
    } else if (lastBusyAt > 0 && now - lastBusyAt > IDLE_NOTIFY_MS && !notifiedForCycle) {
      notifiedForCycle = true;
      const msg = 'Bigfish 任务已完成';
      notify(msg, '后端已空闲，可以回来看看结果了');
      petSay('任务完成啦！');
    }
  }, 5000);
}

function stopCompletionWatcher() {
  if (completionWatcherTimer) {
    clearInterval(completionWatcherTimer);
    completionWatcherTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------
function appIconPath() {
  const candidates = [
    path.join(__dirname, 'assets', 'icon.png'),
    path.join(__dirname, 'build', 'icon.png'),
    path.join(__dirname, 'build', 'icon.ico'),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return undefined;
}
function trayIconPath() {
  const candidates = [
    path.join(__dirname, 'assets', 'tray.png'),
    path.join(__dirname, 'assets', 'icon.png'),
    path.join(__dirname, 'build', 'tray.png'),
    path.join(__dirname, 'build', 'icon.png'),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return undefined;
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    icon: appIconPath(),
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0b0f',
    show: false,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (welcomeWindow && !welcomeWindow.isDestroyed()) {
      welcomeWindow.show();
      welcomeWindow.focus();
    }
  });

  // Close hides to tray (keeps the backend alive); real quit goes through the tray.
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    let origin;
    try { origin = new URL(url).origin; } catch { event.preventDefault(); return; }
    if (origin !== `http://${HOST}:${port}`) {
      event.preventDefault();
      if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    }
  });

  // 页面加载完成后注入半透明背景
  mainWindow.webContents.on('did-finish-load', () => applyBackground());

  mainWindow.loadURL(`http://${HOST}:${port}`);
}

function toggleMainWindow() {
  ensurePet();
  if (!mainWindow) { createWindow(); return; }
  if (mainWindow.isVisible()) mainWindow.hide();
  else { mainWindow.show(); mainWindow.focus(); }
}

// ---------------------------------------------------------------------------
// Desktop pet — transparent floating window（鲸鱼娘）
// ---------------------------------------------------------------------------
function createPetWindow() {
  if (petWindow && !petWindow.isDestroyed()) { petWindow.show(); return; }
  petWindow = new BrowserWindow({
    width: 250,
    height: 270,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'pet-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  petWindow.setAlwaysOnTop(true, 'floating');
  // 点击穿透只在 Windows 上可靠；Linux 上开启会导致桌宠点不到
  if (process.platform === 'win32') {
    petWindow.setIgnoreMouseEvents(true, { forward: true });
  }
  petWindow.loadFile(path.join(__dirname, 'pet.html'));
  petWindow.webContents.on('did-finish-load', () => {
    // 新窗口加载完成立刻推送好感度，避免切换模式后条子显示 0
    broadcastAffinity();
  });
  petWindow.on('closed', () => { petWindow = null; });
}

/** 桌宠启用但窗口没了时，重建它（解决关窗后桌宠消失）。 */
function ensurePet() {
  if (settings.petEnabled && (!petWindow || petWindow.isDestroyed())) {
    createPetWindow();
  }
}

function destroyPetWindow() {
  clearPetTimers();
  petWanderDir = null;
  petBounceLeft = 0;
  if (petWindow && !petWindow.isDestroyed()) petWindow.destroy();
  petWindow = null;
}

// ---------------------------------------------------------------------------
// Pet state machine (idle / eat / sleep / walk / run + happy/read/scared/starry)
// ---------------------------------------------------------------------------
let petState = 'idle';
let wanderTimer = null;
let sleepTimer = null;
let eatTimer = null;
let moveTimer = null;
let chatterTimer = null;
let petWanderDir = null;   // null=未在散步；'left'/'right' 当前移动方向
let petBounceLeft = 0;     // 撞墙后还剩几次折返
let petForceRun = false;   // 脱手逃跑等场景强制跑步

function clearPetTimers() {
  clearTimeout(wanderTimer);
  clearTimeout(sleepTimer);
  clearTimeout(eatTimer);
  clearTimeout(chatterTimer);
  clearInterval(moveTimer);
  wanderTimer = sleepTimer = eatTimer = moveTimer = chatterTimer = null;
}

function setPetState(state) {
  petState = state;
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet-state', state);
  }
}

function scheduleSleep() {
  clearTimeout(sleepTimer);
  sleepTimer = setTimeout(() => {
    if (petState === 'idle') setPetState('sleep');
  }, 120 * 1000); // 2 min idle -> sleep
}

function wakePet() {
  clearTimeout(sleepTimer);
  if (petState === 'sleep') setPetState('idle');
  scheduleSleep();
}

function scheduleWander() {
  clearTimeout(wanderTimer);
  wanderTimer = setTimeout(() => {
    if (petState === 'idle') doWander();
    else scheduleWander();
  }, 15000 + Math.random() * 20000);
}

/** 桌宠最大 X（屏幕宽 - 窗口宽）。 */
function petMaxX() {
  const { workAreaSize } = screen.getPrimaryDisplay();
  return workAreaSize.width - 250;
}

/**
 * 散步/跑步：随机走一段距离就停下休息（不必走完全程）。
 * 只有中途碰到墙壁才折返，折返 petBounceLeft 次后歇着。
 * 20% 概率跑步（更快更远）；脱手逃跑（petForceRun）强制跑步。
 */
function doWander() {
  if (!petWindow || petWindow.isDestroyed() || petState !== 'idle') {
    scheduleWander();
    return;
  }
  if (!petWanderDir) petWanderDir = Math.random() < 0.5 ? 'left' : 'right';
  if (petBounceLeft <= 0) petBounceLeft = 1 + Math.floor(Math.random() * 2); // 撞墙后折返 1~2 次
  const maxX = petMaxX();
  const [x, y] = petWindow.getPosition();
  const run = petForceRun || Math.random() < 0.2;
  petForceRun = false;
  // 随机走一段（不一定到墙）
  const distance = run ? 200 + Math.random() * 300 : 80 + Math.random() * 200;
  let targetX = petWanderDir === 'left' ? x - distance : x + distance;
  const hitWall = petWanderDir === 'left' ? targetX <= 0 : targetX >= maxX;
  if (hitWall) {
    targetX = petWanderDir === 'left' ? 0 : maxX; // 撞墙：走到墙为止，之后折返
  }
  const dist = Math.abs(targetX - x);
  if (dist < 4) {
    // 已经在墙边且方向朝墙 → 直接折返
    petWanderDir = petWanderDir === 'left' ? 'right' : 'left';
    setPetState('idle');
    doWander();
    return;
  }
  const speed = run ? 0.34 : 0.17; // px/ms
  const duration = Math.max(250, dist / speed);
  setPetState((run ? 'run-' : 'walk-') + petWanderDir);
  const startX = x;
  const startTime = Date.now();
  clearInterval(moveTimer);
  moveTimer = setInterval(() => {
    const t = Math.min(1, (Date.now() - startTime) / duration);
    const nx = Math.round(startX + (targetX - startX) * t);
    petWindow.setPosition(nx, y);
    // 保险：Windows 偶尔会让 setPosition 后的窗口尺寸漂移，随手拉回固定值
    const [cw, ch] = petWindow.getSize();
    if (cw !== 250 || ch !== 270) petWindow.setSize(250, 270);
    if (t >= 1) {
      clearInterval(moveTimer);
      moveTimer = null;
      if (hitWall) {
        // 撞墙 → 折返（1~2 次后停下休息）
        petBounceLeft--;
        if (petBounceLeft > 0) {
          petWanderDir = petWanderDir === 'left' ? 'right' : 'left';
          setPetState('idle');
          doWander();
        } else {
          petWanderDir = null;
          petBounceLeft = 0;
          setPetState('idle');
          scheduleWander();
        }
      } else {
        // 正常走完一段 → 停下休息
        petWanderDir = null;
        petBounceLeft = 0;
        setPetState('idle');
        scheduleWander();
      }
    }
  }, 16);
}

// ---------------------------------------------------------------------------
// 好感度 & 兑换系统
//   好感度：按真实消耗的 token（uncachedInput + output）累积，
//           每 AFFINITY_RATE 个 token 得 1 点，按等级阈值升级。
//   兑换屋：右键鲸鱼娘打开，token → 💴，💴 买食物喂食（喂食加好感）。
// ---------------------------------------------------------------------------
const AFFINITY_RATE = 500;       // 每消耗 500 token = 1 好感点（门槛更低，条动得快）
const EXCHANGE_RATE = 1000;      // 1000 token 兑换 1 💴（门槛更低）
const LEVEL_THRESHOLDS = [0, 20, 50, 100, 180, 300, 450, 650, 900, 1200];
const FOODS = [
  { id: 'fish', name: '小鱼干', price: 1, emoji: '🐟', bonusTokens: 2000, msg: '小鱼干真香~ 好感+4' },
  { id: 'cake', name: '小蛋糕', price: 2, emoji: '🍰', bonusTokens: 4000, msg: '蛋糕好好吃~ 好感+8' },
  { id: 'milk', name: '珍珠奶茶', price: 3, emoji: '🧋', bonusTokens: 6000, msg: '奶茶赛高~ 好感+12' },
];

function affinityFile() {
  return path.join(app.getPath('userData'), 'affinity.json');
}
// 三池分离，杜绝"买食物→赚token→再换钱"的印钞机漏洞：
//   usage  终身消耗的 token（只来自真实 AI 使用，只增不减）→ 决定好感度
//   wallet 可兑换余额（来自使用，兑换时花掉）→ 换 💴
//   bonus  喂食获得的好感点（单向加成，不产生可兑换 token）
let affinity = { usage: 0, wallet: 0, bonus: 0, currency: 0, food: {} };
function loadAffinity() {
  try {
    const saved = JSON.parse(fs.readFileSync(affinityFile(), 'utf8'));
    affinity = {
      usage: Number(saved.usage) || Number(saved.tokens) || 0,
      wallet: Number(saved.wallet) || Number(saved.tokens) || 0,
      bonus: Number(saved.bonus) || 0,
      currency: Number(saved.currency) || 0,
      food: saved.food || {},
    };
  } catch { /* 首次使用 */ }
}
function saveAffinity() {
  try {
    fs.mkdirSync(path.dirname(affinityFile()), { recursive: true });
    fs.writeFileSync(affinityFile(), JSON.stringify(affinity, null, 2), 'utf8');
  } catch (err) { console.error('[bigfish] affinity save failed:', err); }
}

/** 从 dsh 会话缓存汇总已消耗 token（真实信号）。读不到返回 null。 */
function sumSessionTokens() {
  try {
    const file = path.join(dshHome(), 'storages', 'session_projcache.json');
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const sessions = (j.tables && j.tables.sessions) || {};
    let sum = 0;
    for (const key of Object.keys(sessions)) {
      const rows = (sessions[key].rows) || {};
      const tu = rows.tokenUsage && rows.tokenUsage.val;
      if (tu && tu.totals) {
        sum += (tu.totals.uncachedInputTokens || 0) + (tu.totals.outputTokens || 0);
      }
    }
    return sum;
  } catch { return null; }
}
let lastTokenSum = null;
let affinityWatcherTimer = null;

function affinityView() {
  // 好感 = 终身使用换算 + 喂食加成（只增不减，兑换不影响好感）
  const points = Math.floor(affinity.usage / AFFINITY_RATE) + affinity.bonus;
  let level = 1, curThr = LEVEL_THRESHOLDS[0], nextThr = LEVEL_THRESHOLDS[1];
  for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) {
    if (points >= LEVEL_THRESHOLDS[i]) { level = i + 1; curThr = LEVEL_THRESHOLDS[i]; nextThr = LEVEL_THRESHOLDS[i + 1]; }
  }
  const progress = nextThr === undefined ? 1 : Math.min(1, (points - curThr) / (nextThr - curThr));
  return {
    level,
    points,
    pointsToNext: nextThr === undefined ? points : nextThr,
    progress,
    tokens: affinity.wallet,      // 可兑换余额
    usage: affinity.usage,        // 终身消耗
    bonus: affinity.bonus,
    currency: affinity.currency,
    food: { ...affinity.food },
    foods: FOODS.map((f) => ({ ...f, bonusPoints: Math.round(f.bonusTokens / AFFINITY_RATE) })),
    exchangeRate: EXCHANGE_RATE,
    affinityRate: AFFINITY_RATE,
  };
}
function broadcastAffinity() {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet-affinity', affinityView());
  }
}

function startAffinityWatcher() {
  stopAffinityWatcher();
  const sum = sumSessionTokens();
  // 首次使用：把历史消耗一并计入（好感条立刻有进度，之后只累计新增）
  if (affinity.usage === 0 && sum !== null && sum > 0) {
    affinity.usage = sum;
    affinity.wallet = sum;
    saveAffinity();
  }
  lastTokenSum = sum; // 基线：之后只统计新增消耗
  affinityWatcherTimer = setInterval(() => {
    const s2 = sumSessionTokens();
    if (s2 !== null && lastTokenSum !== null) {
      if (s2 > lastTokenSum) {
        const delta = s2 - lastTokenSum;
        lastTokenSum = s2;
        affinity.usage += delta;  // 终身消耗（只增不减）
        affinity.wallet += delta; // 可兑换余额
        saveAffinity();
        // 每攒够 1 点好感才提示（避免刷屏）
        if (Math.floor(affinity.usage / AFFINITY_RATE) > Math.floor((affinity.usage - delta) / AFFINITY_RATE)) {
          const v = affinityView();
          petSay(`好感 +1，现在是 Lv.${v.level} 啦~`);
        }
      } else if (s2 < lastTokenSum) {
        lastTokenSum = s2; // 会话被清理/重建，重新基线
      }
    }
    // 每次都广播（桌宠窗口重建后也能拿到最新值）
    broadcastAffinity();
  }, 10000);
}
function stopAffinityWatcher() {
  if (affinityWatcherTimer) { clearInterval(affinityWatcherTimer); affinityWatcherTimer = null; }
}

/** 右键鲸鱼娘：在它旁边打开兑换窗口。 */
let exchangeWindow = null;
function openExchangeWindow() {
  if (exchangeWindow && !exchangeWindow.isDestroyed()) {
    exchangeWindow.show();
    exchangeWindow.focus();
    return;
  }
  exchangeWindow = new BrowserWindow({
    width: 320,
    height: 500,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: '鲸鱼娘兑换屋',
    autoHideMenuBar: true,
    backgroundColor: '#14161c',
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'exchange-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // 放在鲸鱼娘右侧（放不下就放左边）
  if (petWindow && !petWindow.isDestroyed()) {
    const [px, py] = petWindow.getPosition();
    const [pw] = petWindow.getSize();
    const { workAreaSize } = screen.getPrimaryDisplay();
    let x = px + pw + 6;
    if (x + 320 > workAreaSize.width) x = Math.max(0, px - 326);
    exchangeWindow.setPosition(Math.round(x), Math.round(Math.max(0, Math.min(py, workAreaSize.height - 500))));
  }
  // 缓存爆破：防止 Chromium file:// 缓存加载旧版 exchange.html 导致元素缺失
  const cacheBust = Date.now();
  exchangeWindow.loadFile(path.join(__dirname, 'exchange.html'), { query: { v: cacheBust } });
  exchangeWindow.webContents.on('console-message', (_e, level, message) => {
    try {
      const file = path.join(app.getPath('userData'), 'exchange.log');
      fs.appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${message}\n`);
    } catch { /* best effort */ }
  });
  exchangeWindow.on('closed', () => { exchangeWindow = null; });
}

/** 重置所有数据（删掉 .dsh 目录），用于解决"配置改坏/黑屏/无法回复"等问题。 */
async function resetAllData() {
  const home = dshHome();
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    title: APP_NAME,
    message: '确定要重置所有数据吗？',
    detail: [
      '什么时候该重置：程序黑屏/白屏、界面打不开、一直"回复失败"、改坏了配置、或更换账号想清空所有内容。',
      '',
      '会删除什么：API Key、所有会话记录、预设、设置等（相当于恢复出厂设置）。',
      '',
      '风险提示：删除后不可恢复，需要重新填写 API Key 才能继续使用。',
    ].join('\n'),
    buttons: ['重置并退出', '取消'],
    defaultId: 1,
    cancelId: 1,
  });
  if (choice !== 0) return;
  try {
    stopDsh();
    await new Promise((r) => setTimeout(r, 1500));
    fs.rmSync(home, { recursive: true, force: true });
    notify(APP_NAME, '数据已重置，即将退出，请重新打开');
  } catch (err) {
    console.error('[bigfish] 重置数据失败:', err);
    dialog.showErrorBox(APP_NAME, '重置失败，请手动删除 ' + home);
  }
  quitting = true;
  app.quit();
}

/** 重置配置但保留会话和工程（用于"AI 删插件改坏配置导致后端超时"等场景）。 */
async function resetConfigKeepSessions() {
  const home = dshHome();
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    title: APP_NAME,
    message: '确定要重置插件配置吗？（保留 API Key 和会话）',
    detail: [
      '什么时候用：让 AI 装/删插件后进不去、启动一直超时。',
      '',
      '会删除什么：插件配置（profiles 目录）。',
      '',
      '会保留什么：API Key、设置、会话记录、工程/工作区数据。',
    ].join('\n'),
    buttons: ['重置并退出', '取消'],
    defaultId: 1,
    cancelId: 1,
  });
  if (choice !== 0) return;
  try {
    stopDsh();
    await new Promise((r) => setTimeout(r, 1500));
    fs.rmSync(path.join(home, 'profiles'), { recursive: true, force: true });
    notify(APP_NAME, '插件配置已重置，API Key、会话和工程已保留。即将退出，请重新打开');
  } catch (err) {
    console.error('[bigfish] 重置配置失败:', err);
    dialog.showErrorBox(APP_NAME, '重置失败，请手动删除 ' + path.join(home, 'profiles'));
  }
  quitting = true;
  app.quit();
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function createTray() {
  const icon = trayIconPath();
  if (icon) {
    tray = new Tray(nativeImage.createFromPath(icon));
  } else {
    tray = new Tray(nativeImage.createEmpty());
  }
  tray.setToolTip(APP_NAME);
  tray.on('click', () => toggleMainWindow());
  rebuildTrayMenu();
}

// ---------------------------------------------------------------------------
// 背景图（默认 + 用户自定义）
// ---------------------------------------------------------------------------
let bgCssKey = null;

function backgroundImagePath() {
  const custom = path.join(app.getPath('userData'), 'custom-background.jpg');
  return fs.existsSync(custom) ? custom : path.join(__dirname, 'assets', 'background.jpg');
}

/** 往主窗口注入背景样式（半透明背景图，内容在上层可读）。专注模式注入纯色。 */
function applyBackground() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (bgCssKey) {
    try { mainWindow.webContents.removeInsertedCSS(bgCssKey); } catch { /* ignore */ }
    bgCssKey = null;
  }
  let css;
  if (settings.mode === 'focus') {
    // 专注模式：纯色背景（恢复 dsh 默认主题）
    css = `html { background-image: none !important; }`;
  } else {
    let dataUrl = '';
    try {
      const b64 = fs.readFileSync(backgroundImagePath()).toString('base64');
      dataUrl = `data:image/jpeg;base64,${b64}`;
    } catch { /* 读取失败则用纯色 */ }
    css = `
    html {
      background-image: url('${dataUrl}') !important;
      background-size: cover !important;
      background-position: center !important;
      background-repeat: no-repeat !important;
    }
    /* 深色模式 */
    body[data-ds-dark-theme] { background-color: rgba(21, 21, 23, 0.72) !important; }
    body[data-ds-dark-theme] [class*="_sidebarCol"] { background-color: rgba(27, 27, 28, 0.80) !important; }
    body[data-ds-dark-theme] [class*="_frame"],
    body[data-ds-dark-theme] [class*="_root"],
    body[data-ds-dark-theme] [class*="_centerCol"],
    body[data-ds-dark-theme] [class*="_scrollBody"] { background-color: transparent !important; }
    /* 浅色模式（遮罩更透，浅色背景图才能透出来） */
    body:not([data-ds-dark-theme]) { background-color: rgba(255, 255, 255, 0.50) !important; }
    body:not([data-ds-dark-theme]) [class*="_sidebarCol"] { background-color: rgba(244, 244, 246, 0.65) !important; }
    body:not([data-ds-dark-theme]) [class*="_frame"],
    body:not([data-ds-dark-theme]) [class*="_root"],
    body:not([data-ds-dark-theme]) [class*="_centerCol"],
    body:not([data-ds-dark-theme]) [class*="_scrollBody"] { background-color: transparent !important; }
  `;
  }
  mainWindow.webContents.insertCSS(css).then((key) => { bgCssKey = key; }).catch(() => {});
}

/** 切换模式：whale=鲸鱼模式（桌宠+背景图）| focus=专注模式（无桌宠、纯色背景）。 */
function setMode(mode) {
  const m = mode === 'focus' ? 'focus' : 'whale';
  settings.mode = m;
  settings.petEnabled = m === 'whale';
  settings.modeChosen = true;
  settings.lastModeVersion = app.getVersion();
  saveSettings();
  if (m === 'focus') {
    destroyPetWindow();
  } else {
    ensurePet();
  }
  applyBackground();
  rebuildTrayMenu();
}

/** 首次安装 / 更新后弹窗让用户选择模式。 */
function maybeShowModeDialog() {
  const firstRun = !settings.modeChosen;
  const updated = settings.lastModeVersion !== app.getVersion();
  if (!firstRun && !updated) return;
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    title: APP_NAME,
    message: '选择你的 Bigfish 模式',
    detail: [
      '🐳 鲸鱼模式：桌宠鲸鱼娘陪伴，带背景图（默认）。',
      '🧘 专注模式：隐藏桌宠，恢复纯色背景，适合专心工作学习。',
      '',
      '之后可以在右下角托盘 → 模式 随时切换。',
    ].join('\n'),
    buttons: ['鲸鱼模式', '专注模式'],
    defaultId: 0,
    cancelId: 0,
  });
  setMode(choice === 0 ? 'whale' : 'focus');
}

/** 让用户选一张图作为自定义背景。 */
async function chooseBackground() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择背景图片',
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return;
  try {
    fs.copyFileSync(result.filePaths[0], path.join(app.getPath('userData'), 'custom-background.jpg'));
    applyBackground();
    notify(APP_NAME, '背景已更换');
  } catch (err) {
    console.error('[bigfish] 更换背景失败:', err);
  }
}

/** 恢复默认背景。 */
function resetBackground() {
  try { fs.unlinkSync(path.join(app.getPath('userData'), 'custom-background.jpg')); } catch { /* 没有自定义背景 */ }
  applyBackground();
  notify(APP_NAME, '已恢复默认背景');
}

function rebuildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏 Bigfish', click: () => toggleMainWindow() },
    { label: '新手向导（设置 API Key）', click: () => createWelcomeWindow() },
    { label: '插件市场', click: () => createMarketWindow() },
    { label: '鲸鱼娘兑换屋', click: () => openExchangeWindow() },
    { type: 'separator' },
    { label: '更换背景', click: () => chooseBackground() },
    { label: '恢复默认背景', click: () => resetBackground() },
    { type: 'separator' },
    {
      label: '模式',
      submenu: [
        { label: '🐳 鲸鱼模式（桌宠 + 背景图）', type: 'radio', checked: settings.mode !== 'focus', click: () => setMode('whale') },
        { label: '🧘 专注模式（隐藏桌宠 + 纯色背景）', type: 'radio', checked: settings.mode === 'focus', click: () => setMode('focus') },
      ],
    },
    { label: '任务完成时通知', type: 'checkbox', checked: settings.notifyOnComplete, click: (item) => setNotify(item.checked) },
    { label: '开机自启', type: 'checkbox', checked: settings.launchAtLogin, click: (item) => setAutoStart(item.checked) },
    { type: 'separator' },
    {
      label: 'Windows 右键菜单',
      submenu: [
        { label: '安装「用 Bigfish 打开」', click: () => installContextMenu() },
        { label: '卸载', click: () => uninstallContextMenu() },
      ],
    },
    { type: 'separator' },
    { label: '重置插件配置（保留 API Key 和会话）', click: () => resetConfigKeepSessions() },
    { label: '彻底恢复出厂（清空所有）', click: () => resetAllData() },
    { label: '卸载 Bigfish', click: () => uninstall() },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function setNotify(enabled) {
  settings.notifyOnComplete = enabled;
  saveSettings();
  if (!enabled) { lastBusyAt = 0; notifiedForCycle = false; }
}

function setAutoStart(enabled) {
  settings.launchAtLogin = enabled;
  saveSettings();
  app.setLoginItemSettings({ openAtLogin: enabled });
}

function setPetEnabled(enabled) {
  settings.petEnabled = enabled;
  saveSettings();
  if (enabled) createPetWindow();
  else destroyPetWindow();
}

// ---------------------------------------------------------------------------
// Global shortcut
// ---------------------------------------------------------------------------
function registerShortcuts() {
  const accel = 'CommandOrControl+Shift+D';
  try {
    globalShortcut.register(accel, () => toggleMainWindow());
    console.log(`[bigfish] global shortcut registered: ${accel}`);
  } catch (err) {
    console.error('[bigfish] shortcut register failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Windows "Open with Bigfish" context menu
// ---------------------------------------------------------------------------
function runReg(args) {
  return new Promise((resolve) => {
    const child = spawn('reg', args, { stdio: 'ignore', windowsHide: true });
    child.on('exit', () => resolve());
    child.on('error', () => resolve());
  });
}

async function installContextMenu() {
  if (!app.isPackaged) {
    dialog.showMessageBox({ type: 'info', title: APP_NAME, message: '右键菜单只在安装后的版本可用', detail: '请安装打包好的 Bigfish 后再设置右键菜单。' });
    return;
  }
  const exe = process.execPath;
  const cmd = `"${exe}" --open "%1"`;
  const roots = ['HKCU\\Software\\Classes\\*\\shell\\Bigfish', 'HKCU\\Software\\Classes\\Directory\\shell\\Bigfish'];
  for (const r of roots) {
    await runReg(['add', r, '/ve', '/t', 'REG_SZ', '/d', '用 Bigfish 打开', '/f']);
    await runReg(['add', `${r}\\command`, '/ve', '/t', 'REG_SZ', '/d', cmd, '/f']);
    await runReg(['add', r, '/v', 'Icon', '/t', 'REG_SZ', '/d', `${exe},0`, '/f']);
  }
  notify(APP_NAME, '已添加右键「用 Bigfish 打开」');
}

async function uninstallContextMenu() {
  await runReg(['delete', 'HKCU\\Software\\Classes\\*\\shell\\Bigfish', '/f']);
  await runReg(['delete', 'HKCU\\Software\\Classes\\Directory\\shell\\Bigfish', '/f']);
  notify(APP_NAME, '已移除右键菜单');
}

// ---------------------------------------------------------------------------
// --open <path> handling
// ---------------------------------------------------------------------------
function handleOpenArg(argv) {
  const i = argv.indexOf('--open');
  if (i === -1 || !argv[i + 1]) return;
  const target = argv[i + 1];
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  notify(APP_NAME, `已打开: ${target}`);
}

// ---------------------------------------------------------------------------
// Plugin manager — install/remove DSH plugins in the web profile
// (~/.dsh/profiles/web) using the bundled pnpm, then restart the backend.
// ---------------------------------------------------------------------------
const PLUGIN_REGISTRY_URL = 'https://awesome-dsh-plugin.com/plugins.json';
const PLUGIN_REGISTRY_FALLBACK = 'https://cdn.jsdelivr.net/gh/turtle2209/Bigfish@main/plugins.json';
const NPM_REGISTRY = 'https://registry.npmmirror.com/';

function profileDir() {
  return path.join(dshHome(), 'profiles', 'web');
}
function bundledPluginsDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bundled-plugins')
    : path.join(app.getAppPath(), 'bundled-plugins');
}
function bundledPnpmPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'node-runtime', 'pnpm', 'pnpm.mjs')
    : path.join(app.getAppPath(), 'node-runtime', 'pnpm', 'pnpm.mjs');
}
function runtimeNodeExe() {
  if (app.isPackaged) {
    const nodeBin = process.platform === 'win32' ? 'node.exe' : 'node';
    return path.join(process.resourcesPath, 'node-runtime', nodeBin);
  }
  return process.env.DSH_NODE || 'node';
}

function readProfileManifest() {
  const file = path.join(profileDir(), 'package.json');
  // 瞬时文件锁/并发写时重试，避免误判为"不存在"
  for (let i = 0; i < 3; i++) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (i === 2) {
        console.warn('[bigfish] readProfileManifest failed:', err && err.message);
        return null;
      }
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120); } catch { /* ignore */ }
    }
  }
  return null;
}
function writeProfileManifest(manifest) {
  const file = path.join(profileDir(), 'package.json');
  fs.mkdirSync(profileDir(), { recursive: true });
  // 原子写：先写临时文件再改名，杜绝读者读到半截 JSON
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
function profileBundles() {
  const m = readProfileManifest();
  // 注意：dsh.profile 是对象 { bundles: [...] }，不是数组（勿用 Array.isArray(m.dsh.profile)）
  if (!m || !m.dsh || !m.dsh.profile || !Array.isArray(m.dsh.profile.bundles)) return [];
  return m.dsh.profile.bundles;
}
function addBundle(pkgName) {
  if (!isPlainPackageName(pkgName)) {
    console.warn('[bigfish] 拒绝把非包名写入 bundles:', pkgName);
    return false;
  }
  const m = readProfileManifest();
  // 防呆：读不到 manifest 直接抛错，绝不拿默认空表覆盖（会清空注册表）
  if (!m) throw new Error('无法读取 profile manifest，已中止（防止清空插件注册表）');
  if (!m.dsh) m.dsh = { profile: { bundles: [] } };
  if (!m.dsh.profile) m.dsh.profile = { bundles: [] };
  if (!Array.isArray(m.dsh.profile.bundles)) m.dsh.profile.bundles = [];
  if (!m.dsh.profile.bundles.includes(pkgName)) m.dsh.profile.bundles.push(pkgName);
  writeProfileManifest(m);
  return true;
}
function removeBundle(pkgName) {
  const m = readProfileManifest();
  if (!m || !m.dsh || !m.dsh.profile || !Array.isArray(m.dsh.profile.bundles)) return;
  m.dsh.profile.bundles = m.dsh.profile.bundles.filter((b) => b !== pkgName);
  writeProfileManifest(m);
}
/** 是否像合法的 npm 包名（拒绝 github:/git+/link: 等原始安装标识）。 */
function isPlainPackageName(name) {
  if (typeof name !== 'string' || !name) return false;
  if (/^(github:|git\+|link:|file:|\.|\/)/.test(name)) return false;
  if (name.startsWith('@')) {
    return /^@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-~][a-z0-9-._~]*$/.test(name);
  }
  return /^[a-z0-9-~][a-z0-9-._~]*$/.test(name);
}

/** 把安装标识解析成实际安装的包名（github:user/repo → 按仓库名精确匹配 node_modules 里真实包名）。 */
function resolveInstalledName(spec) {
  const base = String(spec || '').replace(/^builtin:/, '').split('#')[0];
  const candidates = listInstalledPlugins();
  if (candidates.includes(base)) return base;
  const repo = (base.match(/github:([^/]+\/[^/#@]+)/) || [])[1];
  if (repo) {
    const repoName = repo.split('/')[1].toLowerCase();
    // 精确匹配（绝不能 includes 子串：dsh-pet-remielle 会误匹配 dsh-pet）
    const hit = candidates.find((n) => n.split('/').pop().toLowerCase() === repoName);
    if (hit) return hit;
  }
  // 兜底：取末尾合法段（去掉版本号）
  const last = base.split('@').pop();
  return isPlainPackageName(last) ? last : null;
}

/**
 * 启动前清理 profile 里损坏的 bundle 注册（例如被写进去的 github:xxx 原始标识），
 * 避免后端启动直接崩掉（dsh CLI 遇到不可解析的 bundle 会抛错退出）。
 */
function sanitizeProfileBundles() {
  try {
    const m = readProfileManifest();
    if (!m || !m.dsh || !m.dsh.profile || !Array.isArray(m.dsh.profile.bundles)) return;
    const before = m.dsh.profile.bundles;
    const cleaned = before.filter((b) => {
      if (!isPlainPackageName(b)) return false; // github:/git+/link: 等非法标识
      if (b.startsWith('@deepseek-ai/')) return true; // 官方基础包
      try { return fs.existsSync(path.join(profileDir(), 'node_modules', b)); } // 包必须真的装了
      catch { return false; }
    });
    if (cleaned.length !== before.length) {
      m.dsh.profile.bundles = cleaned;
      writeProfileManifest(m);
      console.warn('[bigfish] 已清理非法 bundle 注册:', before.filter((b) => !cleaned.includes(b)).join(', '));
    }
  } catch { /* 读不到就算了 */ }
}
function isPluginInProfile(pkgName) {
  if (profileBundles().includes(pkgName)) return true;
  try {
    return fs.existsSync(path.join(profileDir(), 'node_modules', pkgName));
  } catch {
    return false;
  }
}
/** Installed plugin names (from bundles + node_modules presence). */
function listInstalledPlugins() {
  const names = new Set(profileBundles());
  try {
    const nm = path.join(profileDir(), 'node_modules');
    if (fs.existsSync(nm)) {
      for (const entry of fs.readdirSync(nm)) {
        if (entry.startsWith('.') || entry === 'node_modules') continue; // 跳过 .pnpm 等元数据目录
        if (entry.startsWith('@')) {
          const scoped = path.join(nm, entry);
          if (fs.statSync(scoped).isDirectory()) {
            for (const sub of fs.readdirSync(scoped)) names.add(`${entry}/${sub}`);
          }
        } else if (fs.statSync(path.join(nm, entry)).isDirectory()) {
          names.add(entry);
        }
      }
    }
  } catch { /* best effort */ }
  return [...names].sort();
}

/** 已安装但被禁用的插件（在 node_modules 但不在 bundles 里 = 装了但没加载）。 */
function listDisabledPlugins() {
  const bundles = new Set(profileBundles());
  const out = [];
  try {
    const nm = path.join(profileDir(), 'node_modules');
    if (fs.existsSync(nm)) {
      for (const entry of fs.readdirSync(nm)) {
        if (entry.startsWith('.') || entry === 'node_modules') continue;
        const names = [];
        if (entry.startsWith('@')) {
          const scoped = path.join(nm, entry);
          if (fs.statSync(scoped).isDirectory()) {
            for (const sub of fs.readdirSync(scoped)) names.push(`${entry}/${sub}`);
          }
        } else if (fs.statSync(path.join(nm, entry)).isDirectory()) {
          names.push(entry);
        }
        for (const n of names) {
          if (n.startsWith('@deepseek-ai/')) continue;
          if (!bundles.has(n)) out.push(n);
        }
      }
    }
  } catch { /* best effort */ }
  return out;
}

/** Run a command, capturing combined output. */
function runCmd(command, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      ...opts,
    });
    let out = '';
    const onData = (c) => { out += String(c); };
    if (child.stdout) child.stdout.on('data', onData);
    if (child.stderr) child.stderr.on('data', onData);
    child.on('error', (err) => resolve({ code: -1, output: out + '\n' + (err && err.message) }));
    child.on('close', (code) => resolve({ code, output: out }));
  });
}

/** pnpm add/remove 在 profile 目录（workspace 根）需要 -w 标志。 */
function pnpmArgs(action, spec) {
  const args = [bundledPnpmPath(), action];
  const ws = path.join(profileDir(), 'pnpm-workspace.yaml');
  if (fs.existsSync(ws) && (action === 'add' || action === 'remove')) args.push('-w');
  args.push('--dir', profileDir());
  // 用 --config.registry 而不是 --registry：pnpm remove 不识别 --registry
  args.push('--config.registry=' + NPM_REGISTRY);
  // store 固定到 DSH_HOME 下，避免写入程序安装目录（Program Files 只读）或系统盘
  args.push('--store-dir', path.join(dshHome(), 'pnpm-store'));
  if (action === 'add' && spec) args.push(spec);
  if (action === 'remove' && spec) args.push(spec);
  return args;
}

/** profile node_modules 顶层包名集合（跳过 .pnpm 等元数据）。 */
function topLevelModules() {
  const nm = path.join(profileDir(), 'node_modules');
  const out = new Set();
  try {
    for (const e of fs.readdirSync(nm)) {
      if (e.startsWith('.')) continue;
      if (e.startsWith('@')) {
        const scoped = path.join(nm, e);
        if (fs.statSync(scoped).isDirectory()) {
          for (const sub of fs.readdirSync(scoped)) out.add(`${e}/${sub}`);
        }
      } else if (fs.statSync(path.join(nm, e)).isDirectory()) {
        out.add(e);
      }
    }
  } catch { /* best effort */ }
  return out;
}

/** 安装插件：内置插件离线拷贝；npm 插件走 pnpm add。返回 { ok, message } */
async function installPlugin(spec) {
  const bundledName = String(spec).replace(/^builtin:/, '');
  const bundledSource = path.join(bundledPluginsDir(), bundledName);
  if (fs.existsSync(bundledSource)) {
    // 内置插件：直接拷贝进 profile 的 node_modules（离线，不依赖网络）
    const target = path.join(profileDir(), 'node_modules', bundledName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(bundledSource, target, { recursive: true });
    addBundle(bundledName);
    return { ok: true, message: `已安装内置插件 ${bundledName}` };
  }
  // npm / GitHub 插件：用内置 pnpm 安装到 profile
  const beforeMods = topLevelModules();
  const beforeDeps = (() => { const b = readProfileManifest(); return b && b.dependencies ? Object.keys(b.dependencies) : []; })();
  const res = await runCmd(runtimeNodeExe(), pnpmArgs('add', spec), { timeout: 15 * 60 * 1000 });
  if (res.code !== 0) {
    return { ok: false, message: `安装失败（pnpm exit ${res.code}）：\n${res.output.slice(-800)}` };
  }
  // 解析【真实包名】注册 bundles（严禁把 github:user/repo 这类原始标识写进 bundles）
  let realName = null;
  const m = readProfileManifest();
  const afterDeps = m && m.dependencies ? Object.keys(m.dependencies) : [];
  const addedDeps = afterDeps.filter((d) => !beforeDeps.includes(d));
  if (addedDeps.length > 0) {
    realName = addedDeps[0]; // pnpm add 会把真实包名写进 dependencies
  } else {
    // 兜底：扫描 node_modules 新增的顶层包（pnpm 装好后按 package.json 名落位）
    const afterMods = topLevelModules();
    const newMods = [...afterMods].filter((n) => !beforeMods.has(n) && !n.startsWith('@deepseek-ai/'));
    if (newMods.length > 0) realName = newMods[0];
  }
  if (!realName) {
    return { ok: false, message: `安装没有产生可识别的新插件（pnpm 已退出 0 但未落包）。\n原始标识：${spec}\n若从 GitHub 安装，请确认仓库里有合法的 package.json。` };
  }
  addBundle(realName);
  return { ok: true, message: `已安装 ${realName}` };
}

/** 卸载插件：内置插件直接删目录；npm 插件走 pnpm remove。 */
async function uninstallPlugin(pkgName) {
  const bundledSource = path.join(bundledPluginsDir(), pkgName);
  if (fs.existsSync(bundledSource)) {
    const target = path.join(profileDir(), 'node_modules', pkgName);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    removeBundle(pkgName);
    return { ok: true, message: `已卸载内置插件 ${pkgName}` };
  }
  const res = await runCmd(runtimeNodeExe(), pnpmArgs('remove', pkgName), { timeout: 10 * 60 * 1000 });
  if (res.code !== 0) {
    // pnpm 可能已经改了一半，无论如何把 bundles 清理掉
    removeBundle(pkgName);
    return { ok: true, message: `已卸载 ${pkgName}（pnpm 有警告，已清理注册）` };
  }
  removeBundle(pkgName);
  return { ok: true, message: `已卸载 ${pkgName}` };
}

/** 重启后端并让主窗口重新加载（插件生效必须重启）。 */
async function restartBackend() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    stopDsh();
    await new Promise((r) => setTimeout(r, 1500));
    await startDsh();
    return true;
  }
  const oldPort = port;
  stopDsh();
  await new Promise((r) => setTimeout(r, 1500));
  await startDsh();
  if (port !== oldPort) {
    mainWindow.loadURL(`http://${HOST}:${port}`);
  } else {
    mainWindow.reload();
  }
  return true;
}

// ---------------------------------------------------------------------------
// 插件市场窗口（market.html）
// ---------------------------------------------------------------------------
let marketWindow = null;

function createMarketWindow() {
  if (marketWindow && !marketWindow.isDestroyed()) {
    marketWindow.show();
    marketWindow.focus();
    return;
  }
  marketWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    title: 'Bigfish 插件市场',
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'market-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // 缓存爆破：防止 Chromium file:// 缓存加载旧版 market.html 导致元素缺失
  marketWindow.loadFile(path.join(__dirname, 'market.html'), { query: { v: Date.now() } });
  marketWindow.webContents.on('console-message', (_e, level, message) => {
    try {
      const file = path.join(app.getPath('userData'), 'market.log');
      fs.appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${message}\n`);
    } catch { /* best effort */ }
  });
  marketWindow.on('closed', () => { marketWindow = null; });
}

/** 拉取市场目录：优先社区最大平台（awesome-dsh-plugin.com 在线全量），
 *  其次 jsdelivr 上的 Bigfish 精选目录，最后用内置本地副本。 */
async function fetchPluginRegistry() {
  const bundled = path.join(__dirname, 'plugins.json');
  let local = null;
  try { local = JSON.parse(fs.readFileSync(bundled, 'utf8')); } catch { /* no local */ }
  const tryFetch = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.ok) {
        const j = await res.json();
        if (j && Array.isArray(j.plugins)) return { source: 'remote', fetchedAt: Date.now(), plugins: j.plugins };
      }
    } catch { /* try next */ } finally { clearTimeout(timer); }
    return null;
  };
  const online = await tryFetch(PLUGIN_REGISTRY_URL);
  if (online) return online;
  const fallback = await tryFetch(PLUGIN_REGISTRY_FALLBACK);
  if (fallback) return { ...fallback, source: 'mirror' };
  if (local) return { source: 'local', fetchedAt: 0, plugins: local.plugins || [] };
  return { source: 'none', fetchedAt: 0, plugins: [] };
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
    handleOpenArg(argv);
  });

  app.whenReady().then(async () => {
    loadSettings();
    let booted = false;
    try {
      await startDsh();
      console.log(`[bigfish] backend ready at http://${HOST}:${port}`);
      createWindow();
      console.log('[bigfish] window created');
      booted = true;
    } catch (err) {
      // 第一次失败：清理残留后重试一次（常见于上次异常退出导致端口/进程残留）
      try {
        stopDsh();
        cleanupStaleDsh();
        await new Promise((r) => setTimeout(r, 1500));
        await startDsh();
        console.log(`[bigfish] backend ready (retry) at http://${HOST}:${port}`);
        createWindow();
        console.log('[bigfish] window created (retry)');
        booted = true;
      } catch (err2) {
        // 两次都失败：很可能是插件配置被改坏，引导用户重置（尽量保留信息）
        const message = err2 && err2.message ? err2.message : String(err2);
        const choice = dialog.showMessageBoxSync({
          type: 'warning',
          title: APP_NAME,
          message: '后端启动失败，可能是插件配置损坏',
          detail: [
            '错误：' + message,
            '',
            '常见原因：使用「创造模式」让 AI 装/删插件后，插件配置被改坏。',
            '',
            '· 重置插件配置：只清插件配置，保留 API Key、会话、工程，然后自动重试。',
            '· 彻底恢复出厂：清空所有数据（API Key、会话、工程都会删）。',
          ].join('\n'),
          buttons: ['重置插件配置并重试', '彻底恢复出厂', '退出'],
          defaultId: 0,
          cancelId: 2,
        });
        if (choice === 0 || choice === 1) {
          try {
            const home = dshHome();
            stopDsh();
            cleanupStaleDsh();
            await new Promise((r) => setTimeout(r, 1500));
            if (choice === 0) {
              fs.rmSync(path.join(home, 'profiles'), { recursive: true, force: true });
            } else {
              fs.rmSync(home, { recursive: true, force: true });
            }
            await startDsh();
            console.log(`[bigfish] backend ready (after reset) at http://${HOST}:${port}`);
            createWindow();
            console.log('[bigfish] window created (after reset)');
            booted = true;
          } catch (err3) {
            const m3 = err3 && err3.message ? err3.message : String(err3);
            dialog.showErrorBox(
              APP_NAME,
              '重置后仍无法启动：\n\n' + m3 + '\n\n错误日志：' + path.join(app.getPath('userData'), 'bigfish.log'),
            );
          }
        }
      }
    }

    if (!booted) { app.quit(); return; }

    createTray();
    registerShortcuts();
    startCompletionWatcher();
    loadAffinity();
    startAffinityWatcher();
    setTimeout(checkForUpdates, 5000);
    // 首次安装 / 更新后：弹窗让用户选择模式（鲸鱼 / 专注）
    maybeShowModeDialog();
    if (settings.petEnabled) {
      createPetWindow();
      scheduleWander();
      scheduleSleep();
      schedulePetChatter();
    }
    if (settings.launchAtLogin) setAutoStart(true);
    if (!settings.onboardingDone) createWelcomeWindow();

    handleOpenArg(process.argv);

    app.on('activate', () => {
      ensurePet();
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Live in the tray; do not quit.
  });

  app.on('before-quit', () => {
    quitting = true;
    globalShortcut.unregisterAll();
    stopCompletionWatcher();
    stopAffinityWatcher();
    saveAffinity();
    stopDsh();
  });

  app.on('will-quit', () => {
    stopDsh();
  });

  // Welcome wizard IPC
  ipcMain.on('welcome-open-url', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
  });
  ipcMain.on('welcome-done', () => {
    settings.onboardingDone = true;
    saveSettings();
    if (welcomeWindow && !welcomeWindow.isDestroyed()) welcomeWindow.close();
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  // Pet drag + click
  let petDragStartScreen = null;
  let petDragStartPos = null;
  ipcMain.on('pet-drag-start', (_e, { x, y }) => {
    if (!petWindow) return;
    // 用户开始拖动：立即停掉走动动画，避免瞬移
    if (moveTimer) { clearInterval(moveTimer); moveTimer = null; }
    if (petState === 'walk-left' || petState === 'walk-right' || petState === 'run-left' || petState === 'run-right') setPetState('idle');
    // 停下后重新安排下一次散步（不阻断后续走动）
    scheduleWander();
    petDragStartScreen = { x, y };
    petDragStartPos = petWindow.getPosition();
  });
  ipcMain.on('pet-drag-move', (_e, { x, y }) => {
    if (!petWindow || !petDragStartScreen || !petDragStartPos) return;
    petWindow.setPosition(
      petDragStartPos[0] + (x - petDragStartScreen.x),
      petDragStartPos[1] + (y - petDragStartScreen.y),
    );
    // 保险：拖动后拉回固定尺寸（Windows 偶发尺寸漂移）
    const [cw, ch] = petWindow.getSize();
    if (cw !== 250 || ch !== 270) petWindow.setSize(250, 270);
  });
  ipcMain.on('pet-drag-end', () => {
    if (!petWindow || petWindow.isDestroyed()) return;
    petDragStartScreen = null;
    petDragStartPos = null;
    // 脱手：如果鲸鱼娘被拖到墙壁边缘，她会挣脱并往反方向跑
    const maxX = petMaxX();
    const [x] = petWindow.getPosition();
    if (x <= 4 || x >= maxX - 4) {
      petWanderDir = x <= 4 ? 'right' : 'left';
      petBounceLeft = 2;
      petForceRun = true;
      petSay('哇！被你拖到墙角啦，我跑！');
      setPetState('idle');
      doWander();
    } else {
      scheduleWander();
    }
  });
  ipcMain.on('pet-clicked', () => {
    wakePet();
    toggleMainWindow();
    petSay('要我帮忙吗？');
    // 点击 → 开心动画（新素材）
    setPetState('happy');
    clearTimeout(eatTimer);
    eatTimer = setTimeout(() => {
      if (petState === 'happy') setPetState('idle');
    }, 1600);
  });
  ipcMain.on('pet-right-clicked', () => {
    // 右键：打开鲸鱼娘兑换屋
    wakePet();
    petSay('要兑换点什么吗~');
    openExchangeWindow();
  });
  ipcMain.on('pet-set-ignore-mouse', (_e, ignore) => {
    // 点击穿透只在 Windows 上可靠；Linux 上一旦开启整条鱼都点不到
    if (process.platform !== 'win32') return;
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.setIgnoreMouseEvents(ignore, { forward: true });
    }
  });

  // 插件市场 IPC
  ipcMain.handle('market:list', async () => {
    const registry = await fetchPluginRegistry();
    const installed = listInstalledPlugins();
    const disabled = listDisabledPlugins();
    const bundledNames = [];
    try {
      bundledNames.push(...fs.readdirSync(bundledPluginsDir()));
    } catch { /* no bundled dir */ }
    return { registry, installed, disabled, bundledNames, profileDir: profileDir(), dshHome: dshHome() };
  });
  // 快速状态：只读本地已装/已禁用（不拉在线目录），用于操作后即时刷新
  ipcMain.handle('market:state', () => ({
    installed: listInstalledPlugins(),
    disabled: listDisabledPlugins(),
    bundledNames: (() => { try { return fs.readdirSync(bundledPluginsDir()); } catch { return []; } })(),
  }));
  ipcMain.handle('market:install', async (_e, spec) => {
    if (typeof spec !== 'string' || !spec) return { ok: false, message: '无效的插件标识' };
    return await installPlugin(spec);
  });
  ipcMain.handle('market:uninstall', async (_e, pkg) => {
    if (typeof pkg !== 'string' || !pkg) return { ok: false, message: '无效的插件名' };
    // 解析真实包名（防 github:xxx 原始标识）
    const real = resolveInstalledName(pkg) || pkg;
    return await uninstallPlugin(real);
  });
  // 禁用 = 从 bundles 移除（保留 node_modules，重启后不再加载）；启用 = 加回 bundles
  ipcMain.handle('market:disable', async (_e, pkg) => {
    const real = resolveInstalledName(pkg);
    if (!real) return { ok: false, message: '无法解析插件包名：' + String(pkg).slice(0, 60) };
    removeBundle(real);
    return { ok: true, message: `已禁用 ${real}（重启后生效）` };
  });
  ipcMain.handle('market:enable', async (_e, pkg) => {
    const real = resolveInstalledName(pkg);
    console.log('[bigfish] market:enable input=', JSON.stringify(pkg), 'resolved=', real, 'disabled=', JSON.stringify(listDisabledPlugins()));
    if (!real) return { ok: false, message: '无法解析插件包名：' + String(pkg).slice(0, 60) };
    if (!isPlainPackageName(real)) return { ok: false, message: '非法包名：' + real };
    const added = addBundle(real);
    console.log('[bigfish] market:enable added=', added, 'bundles=', JSON.stringify(profileBundles()));
    return { ok: added, message: added ? `已启用 ${real}（重启后生效）` : `写入失败：${real}` };
  });
  ipcMain.handle('market:restart', async () => {
    try {
      await restartBackend();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: String((err && err.message) || err) };
    }
  });
  ipcMain.on('market-open-external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
  });

  // 好感度 / 兑换屋 IPC
  ipcMain.handle('affinity:view', () => affinityView());
  ipcMain.handle('affinity:exchange', () => {
    const gain = Math.floor(affinity.wallet / EXCHANGE_RATE);
    if (gain <= 0) return { ok: false, message: `还不够兑换 1💴（需 ${EXCHANGE_RATE} token）` };
    affinity.wallet -= gain * EXCHANGE_RATE; // 只花可兑换余额，不动终身消耗（好感不掉）
    affinity.currency += gain;
    saveAffinity();
    broadcastAffinity();
    return { ok: true, message: `兑换了 ${gain}💴`, view: affinityView() };
  });
  ipcMain.handle('affinity:buy', (_e, foodId) => {
    const food = FOODS.find((f) => f.id === foodId);
    if (!food) return { ok: false, message: '没有这种食物' };
    if (affinity.currency < food.price) return { ok: false, message: '💴 不够啦，先去兑换吧' };
    affinity.currency -= food.price;
    affinity.food[food.id] = (affinity.food[food.id] || 0) + 1;
    // 喂食：只加好感点（单向），不产生可兑换 token —— 杜绝"买食物→赚token→再换钱"循环
    affinity.bonus += Math.round(food.bonusTokens / AFFINITY_RATE);
    saveAffinity();
    // 鲸鱼吃播
    petSay(food.msg);
    setPetState('eat');
    clearTimeout(eatTimer);
    eatTimer = setTimeout(() => { if (petState === 'eat') setPetState('idle'); }, 2000);
    broadcastAffinity();
    return { ok: true, message: food.msg, view: affinityView() };
  });
}
