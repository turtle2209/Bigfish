'use strict';
const img = document.getElementById('pet');
const bubble = document.getElementById('bubble');
const affinityFill = document.getElementById('affinity-fill');
const affinityLabel = document.getElementById('affinity-label');

// 新素材：assets/pet-new/<动作>/<动作>-NN.png（240x220 统一画布，共 11 个动作）
// 待机用回原来的帧（新截的待机帧有问题）
const FRAMES = {
  idle: ['assets/pet/idle.png'],
  eat: ['assets/pet-new/eat/eat-01.png', 'assets/pet-new/eat/eat-02.png', 'assets/pet-new/eat/eat-03.png', 'assets/pet-new/eat/eat-04.png'],
  sleep: ['assets/pet-new/sleep/sleep-01.png', 'assets/pet-new/sleep/sleep-02.png'],
  'walk-left': ['assets/pet-new/walk-left/walk-left-01.png', 'assets/pet-new/walk-left/walk-left-02.png', 'assets/pet-new/walk-left/walk-left-03.png', 'assets/pet-new/walk-left/walk-left-04.png'],
  'walk-right': ['assets/pet-new/walk-right/walk-right-01.png', 'assets/pet-new/walk-right/walk-right-02.png', 'assets/pet-new/walk-right/walk-right-03.png', 'assets/pet-new/walk-right/walk-right-04.png'],
  'run-left': ['assets/pet-new/run-left/run-left-01.png', 'assets/pet-new/run-left/run-left-02.png', 'assets/pet-new/run-left/run-left-03.png', 'assets/pet-new/run-left/run-left-04.png'],
  'run-right': ['assets/pet-new/run-right/run-right-01.png', 'assets/pet-new/run-right/run-right-02.png', 'assets/pet-new/run-right/run-right-03.png', 'assets/pet-new/run-right/run-right-04.png'],
  happy: ['assets/pet-new/happy/happy-01.png', 'assets/pet-new/happy/happy-02.png', 'assets/pet-new/happy/happy-03.png', 'assets/pet-new/happy/happy-04.png'],
  read: ['assets/pet-new/read/read-01.png', 'assets/pet-new/read/read-02.png', 'assets/pet-new/read/read-03.png', 'assets/pet-new/read/read-04.png'],
  scared: ['assets/pet-new/scared/scared-01.png', 'assets/pet-new/scared/scared-02.png', 'assets/pet-new/scared/scared-03.png', 'assets/pet-new/scared/scared-04.png'],
  starry: ['assets/pet-new/starry/starry-01.png', 'assets/pet-new/starry/starry-02.png', 'assets/pet-new/starry/starry-03.png', 'assets/pet-new/starry/starry-04.png'],
};
const FRAME_MS = {
  idle: 0, eat: 200, sleep: 600,
  'walk-left': 200, 'walk-right': 200, 'run-left': 120, 'run-right': 120,
  happy: 200, read: 260, scared: 200, starry: 220,
};

let state = 'idle';
let frameIndex = 0;
let animTimer = null;

function setState(s) {
  if (!FRAMES[s]) return;
  state = s;
  frameIndex = 0;
  if (animTimer) { clearInterval(animTimer); animTimer = null; }
  img.src = FRAMES[s][0];
  // 待机帧是 160x160 满幅原图，缩到与新帧(240x220)里鲸鱼同等大小（约 140px），
  // 避免旧待机图看起来偏大
  img.style.height = s === 'idle' ? '140px' : '200px';
  img.classList.toggle('animate-bob', s === 'idle');
  if (FRAMES[s].length > 1 && FRAME_MS[s] > 0) {
    animTimer = setInterval(() => {
      frameIndex = (frameIndex + 1) % FRAMES[s].length;
      img.src = FRAMES[s][frameIndex];
    }, FRAME_MS[s]);
  }
}

// drag to move; a click (no movement) summons the main window
let dragging = false;
let moved = false;
let startX = 0;
let startY = 0;

window.addEventListener('mousedown', (e) => {
  dragging = true;
  moved = false;
  startX = e.screenX;
  startY = e.screenY;
  document.body.style.cursor = 'grabbing';
  window.petAPI.dragStart(startX, startY);
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  if (Math.abs(e.screenX - startX) + Math.abs(e.screenY - startY) > 5) moved = true;
  window.petAPI.dragMove(e.screenX, e.screenY);
});
window.addEventListener('mouseup', () => {
  if (dragging && !moved) window.petAPI.clicked();
  else if (dragging && moved) window.petAPI.dragEnd();
  dragging = false;
  document.body.style.cursor = 'grab';
});
// 右键：在鲸鱼旁打开兑换窗口
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.petAPI.rightClicked();
});

window.petAPI.onSay((msg) => {
  bubble.textContent = msg;
  bubble.classList.add('show');
  setTimeout(() => bubble.classList.remove('show'), 4000);
});
window.petAPI.onState((s) => setState(s));
// 好感度：level / points / pointsToNext / progress(0~1)
window.petAPI.onAffinity((a) => {
  if (a && affinityFill && affinityLabel) {
    affinityFill.style.width = Math.round((a.progress || 0) * 100) + '%';
    affinityLabel.textContent = 'Lv.' + a.level + ' 好感 ' + a.points + '/' + a.pointsToNext;
  }
});

// 点击穿透只在 Windows 上可靠；Linux 上开启会导致整个桌宠点不到。
// 用 navigator.platform 判断（渲染进程里拿不到 process.platform）
const isWindows = /Win/i.test(navigator.platform || '');
if (isWindows) {
  // Click-through: only the pet image and the visible bubble capture the mouse;
  // the transparent surroundings pass clicks through to the desktop.
  let lastInteractive = false;
  function isInteractivePoint(x, y) {
    const r = img.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    if (bubble.classList.contains('show')) {
      const br = bubble.getBoundingClientRect();
      if (x >= br.left && x <= br.right && y >= br.top && y <= br.bottom) return true;
    }
    return false;
  }
  window.addEventListener('mousemove', (e) => {
    const interactive = isInteractivePoint(e.clientX, e.clientY);
    if (interactive !== lastInteractive) {
      lastInteractive = interactive;
      window.petAPI.setIgnoreMouse(!interactive);
    }
  });
  window.addEventListener('mouseleave', () => {
    if (lastInteractive) {
      lastInteractive = false;
      window.petAPI.setIgnoreMouse(false);
    }
  });
}

setState('idle');
