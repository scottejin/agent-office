const floorplan = document.getElementById('floorplan');
const template = document.getElementById('agentTemplate');
const summaryList = document.getElementById('summaryList');
const ticker = document.getElementById('ticker');
const focusLine = document.getElementById('focusLine');
const dataSource = document.getElementById('dataSource');

let lastEntities = [];
let focusIdx = 0;

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function renderEntities(entities) {
  clearNode(floorplan);
  const fragment = document.createDocumentFragment();

  entities.forEach((entity) => {
    const node = template.content.cloneNode(true);

    node.querySelector('.name').textContent = entity.name;
    node.querySelector('.role').textContent = `${entity.kindLabel} • ${entity.sessionId || entity.id}`;

    const statusEl = node.querySelector('.status');
    statusEl.textContent = entity.status;
    statusEl.classList.add(entity.status);

    const recencyEl = node.querySelector('.recency');
    recencyEl.textContent = `last active ${entity.recency}`;

    node.querySelector('.activity').textContent = `> ${entity.activity}`;
    node.querySelector('.summary').textContent = entity.summary;
    node.querySelector('.thinking').textContent = `🧾 ${entity.proxyLabel}: ${entity.proxyText}`;

    const workstreamEl = node.querySelector('.workstream');
    (entity.tags || []).forEach((item) => {
      const pill = document.createElement('span');
      pill.textContent = item;
      workstreamEl.appendChild(pill);
    });

    fragment.appendChild(node);
  });

  floorplan.appendChild(fragment);
}

function renderSummary(summary, source) {
  const lines = [
    `${summary.total || 0} live entities on the floor`,
    `${summary.active || 0} active now`,
    `${summary.idle || 0} warm/idle`,
    `${summary.stale || 0} stale sessions`,
    'Proxy text is from local JSONL logs (not hidden model thoughts).',
  ];

  clearNode(summaryList);
  lines.forEach((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    summaryList.appendChild(li);
  });

  dataSource.textContent = `${source.note}`;
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
    renderSummary(payload.summary || {}, payload.source || { note: '' });
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
