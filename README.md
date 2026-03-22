# Retro Agent Ops Room

Retro office dashboard that shows **real local OpenClaw activity** (main agent, subagent runs, and recent sessions) with no model/API calls needed for dashboard data.

## What data it uses

Local files only:

- `~/.openclaw/agents/main/sessions/sessions.json`
- `~/.openclaw/subagents/runs.json`
- session JSONL tails under `~/.openclaw/agents/main/sessions/*.jsonl`

The UI label **Activity Proxy** is intentionally honest: it shows recent local message/task snippets, not hidden model reasoning.

## Run (Node server only)

```bash
cd /Users/crab/.openclaw/workspace/retro-ops-room
node server.js
```

Use the Node server above (it serves both the UI and `/api/state`).
Do **not** use `python -m http.server` for this project.

Default bind: `0.0.0.0:4173` (LAN-viewable)

Open:

- Local: `http://localhost:4173`
- LAN: `http://<this-mac-ip>:4173`

Optional:

```bash
HOST=0.0.0.0 PORT=4173 node server.js
```

## Notes

- Frontend polls `/api/state` every 15 seconds.
- Backend is tiny and local-first (Node built-ins only, no npm install needed).
- If local state files are missing, the API returns an error message and the UI shows it.
