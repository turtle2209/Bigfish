'use strict';
/* Bigfish 插件市场 renderer — talks to main.js via window.marketAPI. */

const api = window.marketAPI;

const CATEGORY_LABELS = {
  official: 'Bigfish社区',
  pet: '桌宠',
  fun: '趣味',
  dev: '开发',
  market: '市场工具',
  productivity: '效率',
  ui: '界面',
  tool: '工具',
  agent: 'Agent',
  memory: '记忆',
  vision: '视觉',
  api: 'API/模型',
  security: '安全',
  other: '其他',
};
const CATEGORY_ORDER = ['official', 'pet', 'fun', 'productivity', 'ui', 'market', 'tool', 'agent', 'memory', 'vision', 'api', 'security', 'dev', 'other'];
const CATEGORY_ICONS = {
  pet: '🐳', fun: '🎮', dev: '🛠️', market: '🛒', productivity: '⚡', official: '⭐',
  ui: '🎨', tool: '🧰', agent: '🤖', memory: '🧠', vision: '👁️', api: '🔌', security: '🛡️', other: '🧩',
};

let state = {
  plugins: [],          // normalized entries
  installed: [],        // installed names
  disabled: [],         // installed but disabled (not in bundles)
  bundledNames: [],     // bundled (offline) plugin names
  category: 'all',
  search: '',
  source: 'none',
  busy: false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function toast(msg, kind, actions) {
  const wrap = document.getElementById('toasts');
  const t = el('div', 'toast ' + (kind || ''));
  t.textContent = msg;
  if (actions && actions.length) {
    const row = el('div', 't-actions');
    for (const a of actions) {
      const b = el('button', 'btn ' + (a.cls || ''), a.label);
      b.onclick = () => { a.run(); dismiss(); };
      row.appendChild(b);
    }
    t.appendChild(row);
  }
  wrap.appendChild(t);
  setTimeout(dismiss, 12000);
  function dismiss() {
    if (t.parentNode) t.parentNode.removeChild(t);
  }
}

let modalResolve = null;
function showModal(title, bodyNode, okLabel) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    document.getElementById('m-title').textContent = title;
    const body = document.getElementById('m-body');
    body.innerHTML = '';
    body.appendChild(bodyNode);
    document.getElementById('m-ok').textContent = okLabel || '确定';
    document.getElementById('modal-mask').classList.add('show');
  });
}
function closeModal(result) {
  document.getElementById('modal-mask').classList.remove('show');
  if (modalResolve) { modalResolve(result); modalResolve = null; }
}
document.getElementById('m-ok').onclick = () => closeModal(true);
document.getElementById('m-cancel').onclick = () => closeModal(false);
document.getElementById('modal-mask').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal(false);
});

// ---------------------------------------------------------------------------
// Normalize registry entries
// ---------------------------------------------------------------------------
function normalizePlugin(p, bundled) {
  const desc = (p.description && (p.description.zh || p.description.en)) || p.description || '';
  let installSpec = p.npm;
  let isGitHub = false;
  if (!installSpec && p.install) {
    // "dsh plugin --profile web add github:user/repo" → github spec
    const m = String(p.install).match(/add\s+(github:[^\s]+|link:[^\s]+|[^\s]+)/);
    if (m && m[1].startsWith('github:')) { installSpec = m[1]; isGitHub = true; }
  }
  if (!installSpec && p.url) {
    const m = String(p.url).match(/github\.com\/([^/]+\/[^/]+)/);
    if (m) { installSpec = 'github:' + m[1]; isGitHub = true; }
  }
  let category = p.category || 'other';
  if (bundled || p.official) category = 'official';
  // 未知分类保留原名展示（全量目录分类很多）
  if (!CATEGORY_LABELS[category]) {
    category = String(category).toLowerCase();
    if (!CATEGORY_LABELS[category]) CATEGORY_LABELS[category] = category;
  }
  return {
    id: (p.name || p.npm || installSpec || '').replace(/\s+/g, '-').toLowerCase(),
    name: p.name || p.npm || installSpec,
    owner: p.owner || '',
    url: p.url || '',
    category,
    desc,
    stars: Number(p.stars) || 0,
    installSpec,
    isGitHub,
    bundled: !!bundled,
    official: !!(bundled || p.official),
    screenshots: p.screenshots || [],
    version: p.version || '',
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function currentCategoryLabel() {
  if (state.category === 'all') return '全部';
  if (state.category === 'installed') return '已安装';
  return CATEGORY_LABELS[state.category] || state.category;
}

/** 从安装标识提取包名（兼容 scoped 包 / 版本号 / github 源 / builtin: 前缀）。 */
function pkgBase(spec) {
  let s = String(spec || '').replace(/^builtin:/, '');
  s = s.split('#')[0];
  if (s.startsWith('@')) {
    const slash = s.indexOf('/');
    if (slash > 0) {
      const ver = s.indexOf('@', slash);
      if (ver > 0) s = s.slice(0, ver);
    }
  } else {
    s = s.split('@')[0];
  }
  return s;
}

/** github:user/repo → repo（用于按仓库名匹配实际安装的包名）。 */
function repoBase(spec) {
  const m = String(spec || '').match(/github:([^/]+\/[^/#@]+)/);
  if (m) return m[1].split('/')[1].toLowerCase();
  return null;
}

function isInstalled(p) {
  if (!p.installSpec) return false;
  const name = pkgBase(p.installSpec);
  if (state.installed.includes(name)) return true;
  // 目录里是 github:user/repo 的安装源，但实际包名来自它的 package.json —— 按仓库名【精确】匹配
  // （不能用 includes 子串：dsh-pet-remielle 会误匹配 dsh-pet）
  const repo = repoBase(p.installSpec);
  if (repo) {
    return state.installed.some((n) => n.split('/').pop().toLowerCase() === repo);
  }
  return false;
}

function isDisabled(p) {
  if (!p.installSpec) return false;
  const name = pkgBase(p.installSpec);
  if (state.disabled.includes(name)) return true;
  const repo = repoBase(p.installSpec);
  if (repo) {
    return state.disabled.some((n) => n.split('/').pop().toLowerCase() === repo);
  }
  return false;
}

function filteredPlugins() {
  const q = state.search.trim().toLowerCase();
  return state.plugins.filter((p) => {
    if (state.category === 'installed') {
      if (!isInstalled(p)) return false;
    } else if (state.category !== 'all' && p.category !== state.category) {
      return false;
    }
    if (!q) return true;
    return (p.name + ' ' + p.owner + ' ' + p.desc + ' ' + p.category).toLowerCase().includes(q);
  });
}

function renderTabs() {
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = '';
  const cats = ['all', 'installed', ...CATEGORY_ORDER.filter((c) => state.plugins.some((p) => p.category === c))];
  const installedCount = state.plugins.filter(isInstalled).length;
  for (const c of cats) {
    const b = el('button', 'tab' + (state.category === c ? ' active' : ''));
    if (c === 'all') b.textContent = '全部';
    else if (c === 'installed') b.textContent = '已安装 (' + installedCount + ')';
    else b.textContent = CATEGORY_LABELS[c] || c;
    b.onclick = () => { state.category = c; renderTabs(); renderGrid(); };
    tabs.appendChild(b);
  }
}

function renderGrid() {
  const grid = document.getElementById('grid');
  const empty = document.getElementById('empty');
  grid.innerHTML = '';
  const list = filteredPlugins();
  empty.classList.toggle('hidden', list.length > 0);
  for (const p of list) grid.appendChild(renderCard(p));
  document.getElementById('count-text').textContent =
    `${list.length} 个插件（${currentCategoryLabel()}${state.search ? ' · 搜索「' + state.search + '」' : ''}）`;
}

function renderCard(p) {
  const card = el('div', 'card');
  const head = el('div', 'card-head');
  const icon = el('div', 'card-icon', CATEGORY_ICONS[p.category] || '🧩');
  const titleWrap = el('div');
  titleWrap.appendChild(el('div', 'card-title', p.name));
  const meta = el('div', 'card-meta');
  if (p.official) meta.appendChild(el('span', 'badge official', 'Bigfish 官方'));
  if (p.bundled) meta.appendChild(el('span', 'badge builtin', '内置离线'));
  if (p.isGitHub) meta.appendChild(el('span', 'badge github', 'GitHub'));
  meta.appendChild(el('span', '', p.owner || ''));
  if (p.stars > 0) meta.appendChild(el('span', '', '★ ' + p.stars));
  titleWrap.appendChild(meta);
  head.appendChild(icon);
  head.appendChild(titleWrap);
  card.appendChild(head);

  card.appendChild(el('div', 'card-desc', p.desc || '（无简介）'));

  const foot = el('div', 'card-foot');
  const installed = isInstalled(p);
  const disabled = isDisabled(p);
  if (installed) {
    foot.appendChild(el('span', 'installed-tag', disabled ? '已禁用' : '✓ 已安装'));
  }
  if (p.url) {
    const link = el('a', 'btn', '主页');
    link.href = p.url;
    link.style.textDecoration = 'none';
    link.onclick = (e) => { e.preventDefault(); api.openExternal(p.url); };
    foot.appendChild(link);
  }
  const spacer = el('span', 'spacer');
  foot.appendChild(spacer);

  if (!p.installSpec) {
    foot.appendChild(el('span', 'badge', '不可一键安装'));
  } else if (installed) {
    // 已安装：禁用/启用 + 卸载
    const toggleBtn = el('button', 'btn', disabled ? '启用' : '禁用');
    toggleBtn.onclick = () => (disabled ? onEnable(p) : onDisable(p));
    foot.appendChild(toggleBtn);
    const btn = el('button', 'btn danger', '卸载');
    btn.onclick = () => onUninstall(p);
    foot.appendChild(btn);
  } else {
    const btn = el('button', 'btn primary', p.bundled ? '一键安装' : '安装');
    btn.onclick = () => onInstall(p);
    foot.appendChild(btn);
  }
  card.appendChild(foot);
  return card;
}

// ---------------------------------------------------------------------------
// Install / uninstall / restart
// ---------------------------------------------------------------------------
function confirmModal(title, html, okLabel) {
  const body = el('div');
  body.innerHTML = html;
  return showModal(title, body, okLabel);
}

async function onInstall(p) {
  if (state.busy) return;
  const spec = p.installSpec;
  const name = pkgBase(spec);
  const ok = await confirmModal(
    `安装「${p.name}」？`,
    `<p>插件名：<code>${name}</code></p>
     <p style="margin-top:8px">安装完成后需要<b>重启一次</b>才会生效（会自动重启，不用手动操作）。</p>
     <p style="margin-top:8px">来源：${p.isGitHub ? 'GitHub 仓库（需要本机 git 环境）' : 'npm 官方仓库'}</p>`,
    '安装',
  );
  if (!ok) return;
  setBusy(true);
  try {
    const res = await api.install(spec);
    if (!res.ok) {
      toast(`安装失败：${res.message}`, 'err', []);
      return;
    }
    toast(`✅ ${res.message}，点击重启生效`, 'ok', [
      { label: '立即重启', cls: 'primary', run: () => doRestart() },
      { label: '稍后重启', run: () => {} },
    ]);
  } catch (err) {
    toast(`安装出错：${(err && err.message) || err}`, 'err', []);
  } finally {
    setBusy(false);
  }
  refreshState(); // 快速刷新本地状态，不占用 busy（否则重启按钮会被卡住点不了）
}

async function onUninstall(p) {
  if (state.busy) return;
  const name = pkgBase(p.installSpec);
  const ok = await confirmModal(
    `卸载「${p.name}」？`,
    `<p>将移除插件 <code>${name}</code> 及其注册。卸载后需要<b>重启一次</b>生效。</p>`,
    '卸载',
  );
  if (!ok) return;
  setBusy(true);
  try {
    const res = await api.uninstall(name);
    if (!res.ok) {
      toast(`卸载失败：${res.message}`, 'err', []);
      return;
    }
    toast(`🗑️ ${res.message}，点击重启生效`, 'ok', [
      { label: '立即重启', cls: 'primary', run: () => doRestart() },
      { label: '稍后重启', run: () => {} },
    ]);
  } catch (err) {
    toast(`卸载出错：${(err && err.message) || err}`, 'err', []);
  } finally {
    setBusy(false);
  }
  refreshState(); // 快速刷新本地状态
}

async function onDisable(p) {
  if (state.busy) return;
  const name = pkgBase(p.installSpec);
  const ok = await confirmModal(
    `禁用「${p.name}」？`,
    `<p>将停用插件 <code>${name}</code>（保留文件，不删除）。禁用后需要<b>重启一次</b>生效。</p>`,
    '禁用',
  );
  if (!ok) return;
  setBusy(true);
  try {
    const res = await api.disable(name);
    if (!res.ok) { toast(`禁用失败：${res.message}`, 'err', []); return; }
    toast(`⏸️ ${res.message}`, 'ok', [
      { label: '立即重启', cls: 'primary', run: () => doRestart() },
      { label: '稍后重启', run: () => {} },
    ]);
  } catch (err) {
    toast(`禁用出错：${(err && err.message) || err}`, 'err', []);
  } finally {
    setBusy(false);
  }
  refreshState(); // 快速刷新本地状态
}

async function onEnable(p) {
  if (state.busy) return;
  const name = pkgBase(p.installSpec);
  console.log('[market] enable click:', p.name, 'spec=', p.installSpec, 'name=', name);
  setBusy(true);
  try {
    const res = await api.enable(name);
    console.log('[market] enable result:', JSON.stringify(res));
    if (!res.ok) { toast(`启用失败：${res.message}`, 'err', []); return; }
    toast(`▶️ ${res.message}`, 'ok', [
      { label: '立即重启', cls: 'primary', run: () => doRestart() },
      { label: '稍后重启', run: () => {} },
    ]);
  } catch (err) {
    console.error('[market] enable error', err);
    toast(`启用出错：${(err && err.message) || err}`, 'err', []);
  } finally {
    setBusy(false);
  }
  refreshState(); // 快速刷新本地状态
}

async function doRestart() {
  if (state.busy) return;
  setBusy(true);
  toast('正在重启后端，请稍候…', '', []);
  try {
    const res = await api.restart();
    if (!res.ok) {
      toast('重启失败：' + res.message, 'err', []);
      return;
    }
    toast('已重启，插件生效 ✅', 'ok', []);
    await refreshState();
  } catch (err) {
    toast('重启出错：' + ((err && err.message) || err), 'err', []);
  } finally {
    setBusy(false);
  }
}

function setBusy(v) {
  state.busy = v;
  document.querySelectorAll('.card .btn').forEach((b) => { b.disabled = v; });
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
/** 快速刷新本地状态（已装/已禁用），不拉在线目录 —— 启用/禁用/卸载后立即反映。 */
async function refreshState() {
  try {
    const s = await api.state();
    state.installed = s.installed || [];
    state.disabled = s.disabled || [];
    state.bundledNames = s.bundledNames || [];
    renderTabs();
    renderGrid();
  } catch (err) {
    console.error('[market] state refresh error', err);
  }
}

/** 完整刷新：本地状态 + 在线目录。 */
async function refresh() {
  try {
    const data = await api.list();
    state.installed = data.installed || [];
    state.disabled = data.disabled || [];
    state.bundledNames = data.bundledNames || [];
    state.source = data.registry.source;
    const raw = data.registry.plugins || [];
    const norm = raw
      .map((p) => normalizePlugin(p, false))
      .concat(state.bundledNames.map((n) => normalizePlugin({ name: n, category: 'official', official: true, bundled: true, description: { zh: 'Bigfish 内置插件', en: 'Bundled Bigfish plugin' }, install: 'builtin:' + n }, true)));
    // 已安装但不在目录里的插件（例如用「创造模式」让 AI 装的）也纳入列表，
    // 这样「已安装」标签页能完整列出并卸载
    const known = new Set(norm.map((p) => (p.installSpec ? pkgBase(p.installSpec) : '')));
    for (const name of state.installed) {
      if (name.startsWith('@deepseek-ai/')) continue; // 官方基础包不显示
      if (!known.has(name)) {
        norm.push(normalizePlugin({
          name, owner: '', url: '', category: 'other',
          description: { zh: '已安装的插件（未收录于目录）', en: 'Installed plugin (not in catalog)' },
          npm: null, stars: 0, install: name,
        }, false));
      }
    }
    state.plugins = norm;
    renderStatus();
    renderTabs();
    renderGrid();
  } catch (err) {
    document.getElementById('src-text').textContent = '加载失败：' + (err && err.message);
  }
}

function renderStatus() {
  const dot = document.getElementById('src-dot');
  const txt = document.getElementById('src-text');
  const srcMap = { remote: ['online', '在线目录（awesome-dsh-plugin 全量）'], mirror: ['local', '精选镜像目录（GitHub）'], local: ['local', '内置目录（离线）'], none: ['none', '目录不可用'] };
  const [cls, label] = srcMap[state.source] || ['none', '未知来源'];
  dot.className = 'dot ' + cls;
  txt.textContent = label;
  const installedCount = state.installed.filter((n) => !n.startsWith('@deepseek-ai/')).length;
  document.getElementById('installed-count').textContent = `已安装 ${installedCount} 个插件`;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.getElementById('search').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderGrid();
});
document.getElementById('refresh').onclick = () => refresh();
document.getElementById('link-profile').onclick = () => {
  api.list().then((d) => api.openExternal('file:///' + String(d.profileDir).replace(/\\/g, '/')));
};
document.getElementById('link-repo').onclick = () => api.openExternal('https://github.com/turtle2209/Bigfish');

refresh();
