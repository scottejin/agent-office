const agents = [
  {
    id: "main",
    name: "Crab (Main Agent)",
    role: "Coordinator / user-facing assistant",
    status: "active",
    activity: "Orchestrating tasks + messaging Scott",
    thinking: "Balancing speed, quality, and human-friendly output.",
    workstream: ["Routing", "Decisions", "Final Replies"],
  },
  {
    id: "sub-ops-01",
    name: "Subagent Alpha",
    role: "Frontend builder",
    status: "active",
    activity: "Designing retro ops dashboard UI",
    thinking: "Need the desk pods to feel tactile, not flat.",
    workstream: ["HTML", "CSS", "Micro-animations"],
  },
  {
    id: "sub-ops-02",
    name: "Subagent Bravo",
    role: "Data wrangler",
    status: "idle",
    activity: "Preparing session summaries",
    thinking: "Normalize status labels before rendering.",
    workstream: ["JSON", "Summaries", "Transform"],
  },
  {
    id: "sub-ops-03",
    name: "Subagent Charlie",
    role: "Quality / reviewer",
    status: "active",
    activity: "Checking visual clarity and readability",
    thinking: "Contrast still matters in retro aesthetics.",
    workstream: ["QA", "Accessibility", "Polish"],
  },
  {
    id: "sub-ops-04",
    name: "Subagent Delta",
    role: "Infra runner",
    status: "blocked",
    activity: "Waiting for external API window",
    thinking: "Hold position; retry when slot opens.",
    workstream: ["Network", "Retries", "Queue"],
  },
];

const floorplan = document.getElementById("floorplan");
const template = document.getElementById("agentTemplate");
const summaryList = document.getElementById("summaryList");
const ticker = document.getElementById("ticker");
const focusLine = document.getElementById("focusLine");

function renderAgents() {
  const fragment = document.createDocumentFragment();

  agents.forEach((agent) => {
    const node = template.content.cloneNode(true);

    node.querySelector(".name").textContent = agent.name;
    node.querySelector(".role").textContent = `${agent.role} • ${agent.id}`;

    const statusEl = node.querySelector(".status");
    statusEl.textContent = agent.status;
    statusEl.classList.add(agent.status);

    node.querySelector(".activity").textContent = `> ${agent.activity}`;
    node.querySelector(".thinking").textContent = `🧠 ${agent.thinking}`;

    const workstreamEl = node.querySelector(".workstream");
    agent.workstream.forEach((item) => {
      const pill = document.createElement("span");
      pill.textContent = item;
      workstreamEl.appendChild(pill);
    });

    fragment.appendChild(node);
  });

  floorplan.appendChild(fragment);
}

function renderSummary() {
  const counts = agents.reduce(
    (acc, a) => {
      acc.total += 1;
      acc[a.status] += 1;
      return acc;
    },
    { total: 0, active: 0, idle: 0, blocked: 0 }
  );

  const lines = [
    `${counts.total} agents on the floor`,
    `${counts.active} active at desks`,
    `${counts.idle} on standby`,
    `${counts.blocked} blocked / waiting`,
  ];

  summaryList.innerHTML = "";
  lines.forEach((line) => {
    const li = document.createElement("li");
    li.textContent = line;
    summaryList.appendChild(li);
  });

  ticker.textContent = agents
    .map((a) => `${a.name}: ${a.activity}`)
    .join("  ✦  ");
}

function startClock() {
  const clockEl = document.getElementById("clock");
  const update = () => {
    const now = new Date();
    clockEl.textContent = now.toLocaleString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      weekday: "short",
    });
  };
  update();
  setInterval(update, 1000);
}

function rotateFocusLine() {
  const thoughts = agents.map((a) => `${a.name} → ${a.thinking}`);
  let i = 0;

  const tick = () => {
    focusLine.textContent = thoughts[i % thoughts.length];
    i += 1;
  };

  tick();
  setInterval(tick, 2800);
}

renderAgents();
renderSummary();
startClock();
rotateFocusLine();
