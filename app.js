const floorplan = document.getElementById('floorplan');
const template = document.getElementById('agentTemplate');
const summaryList = document.getElementById('summaryList');
const ticker = document.getElementById('ticker');
const focusLine = document.getElementById('focusLine');

let lastEntities = [];
let focusIdx = 0;

const LAYOUT_STORAGE_KEY = 'retro-ops-room-layout-v1';
const manualLayout = loadManualLayout();

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function hashString(value = '') {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return Math.abs(h >>> 0);
}

function ranged(seed, min, max) {
  const normalized = (seed >>> 0) / 0xffffffff;
  return min + normalized * (max - min);
}

function layoutForEntity(entity, index) {
  const root = `${entity.id}:${entity.sessionKey || ''}:${index}`;
  return {
    // Keep the randomized paper tilt subtle so the board feels intentional, not chaotic.
    podRotate: ranged(hashString(`${root}:pod`), -0.85, 0.85).toFixed(2),
    // Sticky note tilt should swing gently on both sides of zero.
    noteRotate: ranged(hashString(`${root}:note`), -2.4, 2.4).toFixed(2),
    x: ranged(hashString(`${root}:x`), -8, 9).toFixed(1),
    y: ranged(hashString(`${root}:y`), -16, 14).toFixed(1),
    z: 1 + (hashString(`${root}:z`) % 7),
  };
}

function loadManualLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveManualLayout() {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(manualLayout));
  } catch {
    // ignore storage write errors (private mode, storage full, etc)
  }
}

function attachDrag(pod, entityId) {
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let baseX = 0;
  let baseY = 0;
  let liveX = 0;
  let liveY = 0;
  let rafId = null;

  const flushPosition = () => {
    rafId = null;
    pod.style.setProperty('--manual-x', `${liveX.toFixed(1)}px`);
    pod.style.setProperty('--manual-y', `${liveY.toFixed(1)}px`);
  };

  const queueFlush = () => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(flushPosition);
  };

  const releaseDrag = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    pod.classList.remove('dragging');
    pod.style.removeProperty('--pod-z');

    if (pointerId !== null) {
      try {
        pod.releasePointerCapture(pointerId);
      } catch {
        // no-op
      }
    }

    pointerId = null;
    saveManualLayout();
  };

  pod.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;

    event.preventDefault();
    pointerId = event.pointerId;
    pod.setPointerCapture(pointerId);

    const current = manualLayout[entityId] || { x: 0, y: 0 };
    baseX = Number(current.x) || 0;
    baseY = Number(current.y) || 0;
    liveX = baseX;
    liveY = baseY;
    startX = event.clientX;
    startY = event.clientY;

    pod.classList.add('dragging');
    pod.style.setProperty('--pod-z', '20');
  });

  pod.addEventListener('pointermove', (event) => {
    if (pointerId !== event.pointerId) return;

    const dx = event.clientX - startX;
    const dy = event.clientY - startY;

    liveX = baseX + dx;
    liveY = baseY + dy;

    manualLayout[entityId] = { x: Number(liveX.toFixed(1)), y: Number(liveY.toFixed(1)) };
    queueFlush();
  });

  pod.addEventListener('lostpointercapture', releaseDrag);

  const finish = (event) => {
    if (pointerId !== event.pointerId) return;
    releaseDrag();
  };

  pod.addEventListener('pointerup', finish);
  pod.addEventListener('pointercancel', finish);
}

function renderEntities(entities) {
  clearNode(floorplan);
  const fragment = document.createDocumentFragment();

  entities.forEach((entity, index) => {
    const node = template.content.cloneNode(true);

    node.querySelector('.name').textContent = entity.name;
    node.querySelector('.role').textContent = entity.subtitle
      ? `${entity.kindLabel} • ${entity.subtitle}`
      : entity.kindLabel;

    const statusEl = node.querySelector('.status');
    statusEl.textContent = entity.status;
    statusEl.classList.add(entity.status);

    const recencyEl = node.querySelector('.recency');
    recencyEl.textContent = `last active ${entity.recency}`;

    node.querySelector('.activity').textContent = `> ${entity.activity}`;
    node.querySelector('.summary').textContent = entity.summary;
    node.querySelector('.thinking').textContent = entity.proxyText;

    const workstreamEl = node.querySelector('.workstream');
    (entity.tags || []).forEach((item) => {
      const pill = document.createElement('span');
      pill.textContent = item;
      workstreamEl.appendChild(pill);
    });

    const pod = node.querySelector('.agent-pod');
    pod.dataset.entityId = entity.id;

    const layout = layoutForEntity(entity, index);
    pod.style.setProperty('--pod-rotate', `${layout.podRotate}deg`);
    pod.style.setProperty('--pod-x', `${layout.x}px`);
    pod.style.setProperty('--pod-y', `${layout.y}px`);
    pod.style.setProperty('--pod-z', String(layout.z));

    const sticky = node.querySelector('.sticky-note');
    sticky.style.setProperty('--note-rotate', `${layout.noteRotate}deg`);

    const manual = manualLayout[entity.id];
    if (manual) {
      pod.style.setProperty('--manual-x', `${Number(manual.x) || 0}px`);
      pod.style.setProperty('--manual-y', `${Number(manual.y) || 0}px`);
    }

    attachDrag(pod, entity.id);

    fragment.appendChild(node);
  });

  floorplan.appendChild(fragment);
}

function renderSummary(summary) {
  const lines = [
    `${summary.total || 0} live entities on the floor`,
    `${summary.active || 0} active now`,
    `${summary.idle || 0} warm/idle`,
    `${summary.stale || 0} stale sessions`,
    'Proxy text comes from local JSONL logs (not hidden model thoughts).',
  ];

  clearNode(summaryList);
  lines.forEach((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    summaryList.appendChild(li);
  });
}

function renderTicker(entities) {
  ticker.textContent = entities
    .slice(0, 10)
    .map((e) => `${e.name}: ${e.activity}`)
    .join('  ✦  ');
}

function startClock() {
  const clockEl = document.getElementById('clock');
  const update = () => {
    const now = new Date();
    clockEl.textContent = now.toLocaleString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      weekday: 'short',
    });
  };
  update();
  setInterval(update, 1000);
}

function rotateFocusLine() {
  setInterval(() => {
    if (!lastEntities.length) {
      focusLine.textContent = 'Waiting for local state…';
      return;
    }

    const e = lastEntities[focusIdx % lastEntities.length];
    focusLine.textContent = `${e.name} → ${e.proxyText}`;
    focusIdx += 1;
  }, 3000);
}

async function refresh() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const payload = await response.json();
    lastEntities = payload.entities || [];

    renderEntities(lastEntities);
    renderSummary(payload.summary || {});
    renderTicker(lastEntities);

    if (!focusLine.textContent && lastEntities.length) {
      focusLine.textContent = `${lastEntities[0].name} → ${lastEntities[0].proxyText}`;
    }
  } catch (error) {
    focusLine.textContent = `Local data read failed: ${error.message}`;
  }
}

startClock();
rotateFocusLine();
refresh();
setInterval(refresh, 15000);
