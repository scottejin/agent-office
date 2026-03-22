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
const CRON_VISIBILITY_WINDOW_MS = 2 * 60 * 60 * 1000;

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

function hashToken(text = '') {
  let h = 0;
  const value = String(text);
  for (let i = 0; i < value.length; i += 1) {
    h = (h * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(h >>> 0).toString(36).slice(0, 3);
}

function stripRawIds(text) {
  return String(text || '')
    .replace(/\bagent:[^\s|,;]+/gi, '')
    .replace(/\bcron:[^\s|,;]+/gi, '')
    .replace(/\bsession:[^\s|,;]+/gi, '')
    .replace(/\brun:[0-9a-f-]{8,}/gi, 'run')
    .replace(/\bid:\d+/gi, '')
    .replace(/telegram:\d+/gi, 'telegram dm')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '')
    .replace(/[|•]+\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function shortenEntityName(rawName, uniqueFrom, max = 36) {
  const cleaned = stripRawIds(rawName)
    .replace(/agent[:\s]*/gi, '')
    .replace(/session[:\s]*/gi, '')
    .replace(/subagent[:\s]*/gi, 'subagent ')
    .replace(/\s+/g, ' ')
    .trim();

  const base = cleaned || 'Session';
  if (base.length <= max) return base;

  const suffix = hashToken(uniqueFrom || base).toUpperCase();
  const head = base.slice(0, Math.max(12, max - 5)).trimEnd();
  return `${head}…${suffix}`;
}

function shortCode(value) {
  return hashToken(value || 'local').toUpperCase();
}

function stripNoisyPrefixes(text) {
  return String(text || '')
    .replace(/^(?:\[[^\]]{1,32}\]\s*)+/g, '')
    .replace(/^\s*(?:assistant|system|user|tool)\s*:\s*/i, '')
    .replace(/^\s*(?:reply|replying|responding|response|final answer|analysis|context|note|update)\s*(?:to)?\s*[:\-]\s*/i, '')
    .replace(/^\s*>+\s*/g, '')
    .trim();
}

function pickUsefulChunk(text) {
  const chunks = String(text || '')
    .split(/\s*(?:\||•|—|–|->|=>|;)+\s*/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (!chunks.length) return '';

  const noisyChunk =
    /\b(reply|replied|channel|model|provider|tokens?|session|metadata|context|origin|surface|trace|thread|run id|session id)\b/i;
  return chunks.find((chunk) => !noisyChunk.test(chunk)) || chunks[0];
}

function conciseText(text, max = 90) {
  const cleaned = stripNoisyPrefixes(stripRawIds(text))
    .replace(/`[^`]+`/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';

  const chunk = pickUsefulChunk(cleaned);
  const firstSentence = chunk.split(/(?<=[.!?])\s+/).map((s) => s.trim()).find(Boolean) || chunk;
  return shortText(firstSentence, max);
}

function cleanVisible(text, max = 90) {
  return conciseText(text, max);
}

function cleanProxyText(text, max = 44) {
  const compact = conciseText(text, Math.max(max + 24, 80))
    .replace(/^@[^\s:]+\s*/i, '')
    .replace(/^\s*(?:re|fw|fwd)\s*:\s*/i, '')
    .replace(/listening on https?:\/\/\S+/i, 'started local server')
    .replace(/^[\]\[(){}<>\-:;,._\s]+/, '')
    .trim();

  return shortText(compact, max);
}

function sessionSubtitle(session, kind) {
  if (kind === 'telegram') return 'Local DM';
  if (kind === 'cron') return 'Local schedule';
  if (kind === 'subagent-session') return `Desk ${shortCode(session.sessionId || session.key)}`;
  if (kind === 'thread') return 'Main thread';
  if (kind === 'slack') return 'Workspace chat';
  return 'Local session';
}

function cronTitle(session) {
  const title = String(session?.label || session?.displayName || '')
    .replace(/^cron:\s*/i, '')
    .trim();
  return cleanVisible(title, 34);
}

function localNickname(session) {
  const kind = classifySessionKind(session.key || '', session);
  const fallbackSource = session.displayName || session.origin?.label || session.label || session.key || '';

  if (kind === 'telegram') {
    const handle = shortenEntityName(fallbackSource, session.sessionId || session.key, 24);
    return `Telegram · ${handle}`;
  }

  if (kind === 'cron') {
    const title = cronTitle(session);
    return `Cron · ${title || `Job ${shortCode(session.key)}`}`;
  }

  if (kind === 'subagent-session') {
    return `Subagent · Desk ${shortCode(session.sessionId || session.key)}`;
  }

  if (kind === 'thread') {
    const short = shortenEntityName(fallbackSource, session.sessionId || session.key, 24);
    return `Thread · ${short}`;
  }

  const short = shortenEntityName(fallbackSource, session.sessionId || session.key, 24);
  return `Session · ${short}`;
}

function firstLine(text) {
  if (!text) return '';
  return String(text).split('\n').map((s) => s.trim()).find(Boolean) || '';
}

function shortRef(value, max = 16) {
  const v = String(value || '').trim();
  if (!v) return '';
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
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
        if (text) return cleanProxyText(firstLine(text));
      }

      if (event?.type === 'toolCall' && event?.name) {
        return cleanProxyText(`Tool: ${event.name}`);
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
      name: 'Crab · Main',
      subtitle: 'Control room',
      kind,
      kindLabel: labelForKind(kind),
      sessionKey: mainCandidate.key,
      sessionId: shortRef(mainCandidate.sessionId || '', 14),
      type: classifySessionKind(mainCandidate.key, mainCandidate),
      status: recencyBucket(ageMs),
      lastActivityAt: mainCandidate.updatedAt,
      recency: recencyText(ageMs),
      activity: cleanVisible(
        `Latest channel: ${mainCandidate.lastChannel || mainCandidate.origin?.surface || 'local'}`,
        54
      ),
      summary: cleanVisible(mainCandidate.displayName || mainCandidate.origin?.label || 'Main control session', 68),
      proxyText: proxy || 'Awaiting local message',
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
      name: `Subagent · Desk ${shortCode(run.runId)}`,
      subtitle: `Task ${shortCode(run.childSessionKey || run.runId)}`,
      kind: 'subagent-run',
      kindLabel: labelForKind('subagent-run'),
      sessionKey: run.childSessionKey || '',
      sessionId: shortRef(run.runId || '', 14),
      type: run.spawnMode || 'run',
      status,
      lastActivityAt: updatedAt,
      recency: recencyText(ageMs),
      activity: cleanVisible(firstLine(run.task) || 'Task queued by main agent.', 54),
      summary: cleanVisible(`Requester: local session · Cleanup: ${run.cleanup || 'n/a'}`, 68),
      proxyText: proxy || cleanProxyText(firstLine(run.task) || 'Task queued'),
      tags: [
        `model:${run.model || 'unknown'}`,
        `timeout:${toNumber(run.runTimeoutSeconds, 0)}s`,
        `cleanup:${run.cleanup || 'n/a'}`,
      ],
    });
  }

  const recentSessions = sessionEntries.slice(0, 16);
  for (const session of recentSessions) {
    if (session.key === mainCandidate?.key) continue;

    const ageMs = Math.max(0, now - session.updatedAt);
    const kind = classifySessionKind(session.key, session);

    // Hide stale cron jobs entirely from the board.
    if (kind === 'cron' && ageMs > CRON_VISIBILITY_WINDOW_MS) continue;

    const proxy = await proxyFor(session.sessionFile);

    entities.push({
      id: `session:${session.sessionId || session.key}`,
      name: localNickname(session),
      subtitle: sessionSubtitle(session, kind),
      kind,
      kindLabel: labelForKind(kind),
      sessionKey: session.key,
      sessionId: shortRef(session.sessionId || session.key, 14),
      type: session.chatType || kind,
      status: recencyBucket(ageMs),
      lastActivityAt: session.updatedAt,
      recency: recencyText(ageMs),
      activity: cleanVisible(
        session.label ||
          `Channel ${session.lastChannel || session.origin?.surface || 'unknown'} · ${session.lastTo || 'no target'}`,
        54
      ),
      summary: cleanVisible(
        `Tokens: ${session.totalTokens ?? 'n/a'} · Model: ${session.model || 'unknown'} · Provider: ${
          session.modelProvider || 'unknown'
        }`,
        68
      ),
      proxyText: proxy || 'Awaiting local message',
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
