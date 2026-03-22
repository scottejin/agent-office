#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const { URL } = require('url');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = __dirname;

const STATE_ROOT = path.join(process.env.HOME || '', '.openclaw');
const SESSIONS_PATH = path.join(STATE_ROOT, 'agents', 'main', 'sessions', 'sessions.json');
const RUNS_PATH = path.join(STATE_ROOT, 'subagents', 'runs.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function safeNowMs() {
  return Date.now();
}

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function shortText(text, max = 160) {
  if (!text) return '';
  const compact = String(text).replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function firstLine(text) {
  if (!text) return '';
  return String(text).split('\n').map((s) => s.trim()).find(Boolean) || '';
}

function recencyBucket(ageMs) {
  if (ageMs <= 5 * 60_000) return 'active';
  if (ageMs <= 60 * 60_000) return 'idle';
  return 'stale';
}

function recencyText(ageMs) {
  const sec = Math.max(1, Math.floor(ageMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function classifySessionKind(key, entry) {
  if (key.includes(':subagent:')) return 'subagent-session';
  if (key.includes(':cron:')) return 'cron';
  if (key.includes(':telegram:')) return 'telegram';
  if (key.includes(':slack:')) return 'slack';
  if (key.includes(':main:thread:')) return 'thread';
  if (entry?.channel) return entry.channel;
  return 'session';
}

function labelForKind(kind) {
  const labels = {
    'agent-main': 'Main Agent',
    'subagent-run': 'Subagent Run',
    'subagent-session': 'Subagent Session',
    cron: 'Cron Session',
    telegram: 'Telegram Session',
    slack: 'Slack Session',
    thread: 'Thread Session',
    session: 'Session',
  };
  return labels[kind] || 'Session';
}

async function readJson(file) {
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text);
}

async function tailText(filePath, maxBytes = 64 * 1024) {
  const fh = await fs.open(filePath, 'r');
  try {
    const st = await fh.stat();
    const size = st.size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buffer = Buffer.alloc(len);
    await fh.read(buffer, 0, len, start);
    return buffer.toString('utf8');
  } finally {
    await fh.close();
  }
}

function messageTextFromEvent(event) {
  const msg = event?.message;
  if (!msg || !Array.isArray(msg.content)) return '';
  const textBits = msg.content
    .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean);
  return textBits.join(' ');
}

async function extractSessionProxy(sessionFile) {
  if (!sessionFile) return '';
  if (!fssync.existsSync(sessionFile)) return '';

  try {
    const tail = await tailText(sessionFile);
    const lines = tail
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      if (event?.type === 'message') {
        const text = messageTextFromEvent(event);
        if (text) return shortText(firstLine(text));
      }

      if (event?.type === 'toolCall' && event?.name) {
        return shortText(`Tool call: ${event.name}`);
      }
    }
  } catch {
    return '';
  }

  return '';
}

async function buildState() {
  const now = safeNowMs();
  const [sessionsRaw, runsRaw] = await Promise.all([
    readJson(SESSIONS_PATH).catch(() => ({})),
    readJson(RUNS_PATH).catch(() => ({ runs: {} })),
  ]);

  const sessionEntries = Object.entries(sessionsRaw || {}).map(([key, entry]) => ({
    key,
    ...entry,
    updatedAt: toNumber(entry?.updatedAt),
  }));

  sessionEntries.sort((a, b) => b.updatedAt - a.updatedAt);

  const proxyCache = new Map();
  const proxyFor = async (sessionFile) => {
    if (!sessionFile) return '';
    if (proxyCache.has(sessionFile)) return proxyCache.get(sessionFile);
    const value = await extractSessionProxy(sessionFile);
    proxyCache.set(sessionFile, value);
    return value;
  };

  const mainCandidate =
    sessionEntries.find((s) => s.key === 'agent:main:main') ||
    sessionEntries.find((s) => s.key.startsWith('agent:main:')) ||
    null;

  const entities = [];

  if (mainCandidate) {
    const ageMs = Math.max(0, now - mainCandidate.updatedAt);
    const kind = 'agent-main';
    const proxy = await proxyFor(mainCandidate.sessionFile);

    entities.push({
      id: 'agent-main',
      name: 'Crab (Main Agent)',
      kind,
      kindLabel: labelForKind(kind),
      sessionKey: mainCandidate.key,
      sessionId: mainCandidate.sessionId || '',
      type: classifySessionKind(mainCandidate.key, mainCandidate),
      status: recencyBucket(ageMs),
      lastActivityAt: mainCandidate.updatedAt,
      recency: recencyText(ageMs),
      activity: `Latest channel: ${mainCandidate.lastChannel || mainCandidate.origin?.surface || 'local'}`,
      summary: shortText(mainCandidate.displayName || mainCandidate.origin?.label || 'Main control session'),
      proxyLabel: 'Local message proxy',
      proxyText: proxy || 'No recent text event found in local JSONL tail.',
      tags: [
        `model:${mainCandidate.model || 'unknown'}`,
        `provider:${mainCandidate.modelProvider || 'unknown'}`,
        `channel:${mainCandidate.lastChannel || mainCandidate.origin?.surface || 'local'}`,
      ],
    });
  }

  const runs = Object.values(runsRaw?.runs || {}).sort(
    (a, b) => toNumber(b.startedAt || b.createdAt) - toNumber(a.startedAt || a.createdAt)
  );

  const activeRuns = runs.slice(0, 8);
  for (const run of activeRuns) {
    const updatedAt = toNumber(run.startedAt || run.createdAt);
    const ageMs = Math.max(0, now - updatedAt);
    const stillInWindow = toNumber(run.archiveAtMs) > now;
    const status = stillInWindow ? 'active' : recencyBucket(ageMs);

    const matchingSession = sessionEntries.find((s) => s.key === run.childSessionKey);
    const proxy = await proxyFor(matchingSession?.sessionFile);

    entities.push({
      id: `run:${run.runId}`,
      name: `Subagent ${run.runId?.slice(0, 8) || 'unknown'}`,
      kind: 'subagent-run',
      kindLabel: labelForKind('subagent-run'),
      sessionKey: run.childSessionKey || '',
      sessionId: run.runId || '',
      type: run.spawnMode || 'run',
      status,
      lastActivityAt: updatedAt,
      recency: recencyText(ageMs),
      activity: shortText(firstLine(run.task) || 'Task requested by main agent.'),
      summary: shortText(
        `Requester: ${run.requesterDisplayKey || 'unknown'} · Cleanup: ${run.cleanup || 'n/a'}`
      ),
      proxyLabel: 'Task/child-session proxy',
      proxyText: proxy || shortText(firstLine(run.task) || 'No child session text yet.'),
      tags: [
        `model:${run.model || 'unknown'}`,
        `timeout:${toNumber(run.runTimeoutSeconds, 0)}s`,
        `cleanup:${run.cleanup || 'n/a'}`,
      ],
    });
  }

  const recentSessions = sessionEntries.slice(0, 10);
  for (const session of recentSessions) {
    if (session.key === mainCandidate?.key) continue;

    const ageMs = Math.max(0, now - session.updatedAt);
    const kind = classifySessionKind(session.key, session);
    const proxy = await proxyFor(session.sessionFile);

    entities.push({
      id: `session:${session.sessionId || session.key}`,
      name: shortText(session.displayName || session.origin?.label || session.key, 60),
      kind,
      kindLabel: labelForKind(kind),
      sessionKey: session.key,
      sessionId: session.sessionId || '',
      type: session.chatType || kind,
      status: recencyBucket(ageMs),
      lastActivityAt: session.updatedAt,
      recency: recencyText(ageMs),
      activity: shortText(
        session.label ||
          `Channel ${session.lastChannel || session.origin?.surface || 'unknown'} · ${session.lastTo || 'no target'}`
      ),
      summary: shortText(
        `Tokens: ${session.totalTokens ?? 'n/a'} · Model: ${session.model || 'unknown'} · Provider: ${
          session.modelProvider || 'unknown'
        }`
      ),
      proxyLabel: 'Last message proxy',
      proxyText: proxy || 'No recent text event found in local JSONL tail.',
      tags: [
        `kind:${kind}`,
        `channel:${session.lastChannel || session.origin?.surface || 'unknown'}`,
        `system:${session.systemSent ? 'yes' : 'no'}`,
      ],
    });
  }

  entities.sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  const summary = entities.reduce(
    (acc, e) => {
      acc.total += 1;
      acc[e.status] = (acc[e.status] || 0) + 1;
      return acc;
    },
    { total: 0, active: 0, idle: 0, stale: 0 }
  );

  return {
    generatedAt: new Date(now).toISOString(),
    source: {
      sessionsPath: SESSIONS_PATH,
      runsPath: RUNS_PATH,
      note:
        'No model calls are used for this dashboard. Data is read directly from local OpenClaw state files and session JSONL logs.',
    },
    summary,
    entities,
  };
}

async function serveStatic(reqPath, res) {
  let requestPath = reqPath;
  if (requestPath === '/') requestPath = '/index.html';

  const normalized = path.normalize(requestPath).replace(/^\.\.(?:\/|\\|$)/, '');
  const filePath = path.join(PUBLIC_DIR, normalized);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('not-file');

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });

    fssync.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (parsed.pathname === '/api/state') {
    try {
      const payload = await buildState();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(payload));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          error: 'Failed to read local OpenClaw state files',
          details: String(error?.message || error),
        })
      );
    }
    return;
  }

  await serveStatic(parsed.pathname, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Retro Ops Room listening on http://${HOST}:${PORT}`);
  console.log(`LAN: http://<this-mac-ip>:${PORT}`);
});
