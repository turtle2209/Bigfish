'use strict';
const img = document.getElementById('pet');
const bubble = document.getElementById('bubble');
const petWrap = document.getElementById('pet-wrap');
const petInner = document.getElementById('pet-inner');

// -- Scale (wheel on pet) -----------------------------------------------------
let petScale = 1;
const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const SCALE_STEP = 0.1;

function applyScale(s) {
  petScale = Math.round(s * 100) / 100; // avoid floating-point drift
  petInner.style.transform = `scale(${petScale})`;
}

// Receive initial scale from main process
window.petAPI.onScale((s) => applyScale(s));

const FRAMES = {
  idle: ['assets/pet/idle.png'],
  eat: ['assets/pet/eat-1.png', 'assets/pet/eat-2.png', 'assets/pet/eat-3.png', 'assets/pet/eat-4.png'],
  'walk-left': ['assets/pet/walk-left-1.png', 'assets/pet/walk-left-2.png'],
  'walk-right': ['assets/pet/walk-right-1.png', 'assets/pet/walk-right-2.png'],
  sleep: ['assets/pet/sleep.png'],
};
const FRAME_MS = { idle: 0, eat: 220, 'walk-left': 240, 'walk-right': 240, sleep: 0 };

let state = 'idle';
let frameIndex = 0;
let animTimer = null;

function setState(s) {
  if (!FRAMES[s]) return;
  state = s;
  frameIndex = 0;
  if (animTimer) { clearInterval(animTimer); animTimer = null; }
  img.src = FRAMES[s][0];
  img.classList.toggle('animate-bob', s === 'idle');
  if (FRAMES[s].length > 1 && FRAME_MS[s] > 0) {
    animTimer = setInterval(() => {
      frameIndex = (frameIndex + 1) % FRAMES[s].length;
      img.src = FRAMES[s][frameIndex];
    }, FRAME_MS[s]);
  }
}

// -- Position (CSS transform, no setPosition ever) ----------------------------
// The window covers the full work area; the pet is positioned with left/top.
let petX = 300;
let petY = 300;

function setPos(x, y) {
  petX = x;
  petY = y;
  petWrap.style.left = x + 'px';
  petWrap.style.top = y + 'px';
}

// -- Initial position ---------------------------------------------------------
const INIT_X = 300;
const INIT_Y = 300;
setPos(INIT_X, INIT_Y);
window.petAPI.initBounds(screen.availWidth || 1920, screen.availHeight || 1080, INIT_X, INIT_Y);

// -- Drag (purely local, zero IPC during move) --------------------------------
let isDragging = false;
let moved = false;
let dragStartScreenX = 0;
let dragStartScreenY = 0;
let dragStartPetX = 0;
let dragStartPetY = 0;

window.addEventListener('mousedown', (e) => {
  isDragging = true;
  moved = false;
  dragStartScreenX = e.screenX;
  dragStartScreenY = e.screenY;
  dragStartPetX = petX;
  dragStartPetY = petY;
  document.body.style.cursor = 'grabbing';
});
window.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  if (Math.abs(e.screenX - dragStartScreenX) + Math.abs(e.screenY - dragStartScreenY) > 5) moved = true;
  setPos(dragStartPetX + (e.screenX - dragStartScreenX), dragStartPetY + (e.screenY - dragStartScreenY));
});
window.addEventListener('mouseup', () => {
  if (isDragging && !moved) {
    window.petAPI.clicked();
  }
  if (isDragging && moved) {
    // Sync final position to main process (one IPC after entire drag)
    window.petAPI.syncPosition(petX, petY);
  }
  isDragging = false;
  document.body.style.cursor = 'grab';
  // If a wander was queued during drag, start it now
  if (queuedWander) { startWander(queuedWander); queuedWander = null; }
});

// -- Wander animation (receives target from main, animates locally) -----------
let wanderRafId = 0;
let wanderStartX = 0;
let wanderStartY = 0;
let wanderTargetX = 0;
let wanderTargetY = 0;
let wanderStartTime = 0;
const WANDER_DURATION = 1400;
let queuedWander = null;

function animateWander() {
  const elapsed = Date.now() - wanderStartTime;
  const t = Math.min(1, elapsed / WANDER_DURATION);
  const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // easeInOut
  setPos(wanderStartX + (wanderTargetX - wanderStartX) * ease, petY);
  if (t < 1) {
    wanderRafId = requestAnimationFrame(animateWander);
  } else {
    wanderRafId = 0;
    setPos(wanderTargetX, petY);
    setState('idle');
    window.petAPI.syncPosition(petX, petY);
    window.petAPI.wanderDone();
  }
}

function startWander({ targetX, y }) {
  if (isDragging) { queuedWander = { targetX, y }; return; }
  const dir = targetX < petX ? 'walk-left' : 'walk-right';
  setState(dir);
  wanderStartX = petX;
  wanderStartY = y;
  wanderTargetX = targetX;
  wanderStartTime = Date.now();
  if (wanderRafId) cancelAnimationFrame(wanderRafId);
  wanderRafId = requestAnimationFrame(animateWander);
}

window.petAPI.onWander((data) => startWander(data));

// -- Message / state from main process ----------------------------------------
window.petAPI.onSay((msg) => {
  bubble.textContent = msg;
  bubble.classList.add('show');
  setTimeout(() => bubble.classList.remove('show'), 4000);
});
window.petAPI.onState((s) => setState(s));

// -- Click-through ------------------------------------------------------------
let lastInteractive = false;
let ignoreDebounce = null;
const IGNORE_DEBOUNCE_MS = 120;

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
  if (isDragging) return;
  const interactive = isInteractivePoint(e.clientX, e.clientY);
  if (interactive === lastInteractive) return;
  lastInteractive = interactive;
  if (ignoreDebounce) clearTimeout(ignoreDebounce);
  if (!interactive) {
    ignoreDebounce = setTimeout(() => {
      window.petAPI.setIgnoreMouse(true);
    }, IGNORE_DEBOUNCE_MS);
  } else {
    window.petAPI.setIgnoreMouse(false);
  }
});

// -- Scroll wheel to scale (only when pointer is over the pet) ----------------
window.addEventListener('wheel', (e) => {
  if (!isInteractivePoint(e.clientX, e.clientY)) return;
  e.preventDefault();
  const delta = e.deltaY < 0 ? SCALE_STEP : -SCALE_STEP;
  const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, petScale + delta));
  if (next === petScale) return;
  applyScale(next);
  window.petAPI.saveScale(petScale);
}, { passive: false });

setState('idle');
