const root = document.documentElement;
const $ = (id) => document.getElementById(id);

$("year").textContent = new Date().getFullYear();

// ---------------------------------------------------------------- formatting

function bytes(n, digits = 1) {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

function uptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m ${Math.floor(seconds % 60)}s`;
}

const relative = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });
function ago(time) {
  const seconds = (time - Date.now()) / 1000;
  const steps = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const decode = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

// ---------------------------------------------------------------- terminal

const FONT = '"JetBrains Mono", ui-monospace, monospace';
const box = $("term");
let term = null;

// Fit the fixed 120-column terminal with the same padding as the chat window.
// xterm's cells snap to device pixels, so render just larger than the frame and
// shrink slightly; enlarging small rasterised glyphs made the old view blurry.
function fit() {
  if (!term) return;
  const pad = parseFloat(getComputedStyle(root).getPropertyValue("--term-pad"));
  const width = box.clientWidth - pad * 2;
  const screen = box.querySelector(".xterm-screen");
  const rendered = () => screen.offsetWidth;
  const round = (n) => Math.floor(n * 10) / 10;

  for (let i = 0; i < 3; i++) {
    const size = round(term.options.fontSize * (width / rendered()));
    if (!Number.isFinite(size) || size === term.options.fontSize) break;
    term.options.fontSize = size;
  }
  // Pick the *smallest* font that renders at least this wide. Several font sizes
  // share a cell width (at 390px, 5px -> 360px but 7px -> 480px). A binary search
  // avoids a slow sequence of xterm redraws and never chooses the larger jump.
  let low = 40;
  let high = Math.max(low, Math.ceil(term.options.fontSize * 10));
  term.options.fontSize = high / 10;
  if (rendered() < width) {
    high = 320;
    term.options.fontSize = high / 10;
  }
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    term.options.fontSize = mid / 10;
    if (rendered() < width) low = mid + 1;
    else high = mid;
  }
  term.options.fontSize = high / 10;
  const scale = width / rendered();
  screen.style.transformOrigin = "0 0";
  screen.style.transform = scale === 1 ? "none" : `scale(${scale})`;
  box.style.padding = `${pad}px`;
  box.style.height = `${screen.offsetHeight * scale + pad * 2}px`;
}

async function createTerm(cols, rows) {
  // xterm measures the font once when it opens, so it has to be loaded first
  await Promise.all(["400", "700"].map((w) => document.fonts.load(`${w} 16px "JetBrains Mono"`)));
  term = new Terminal({
    cols,
    rows,
    fontFamily: FONT,
    fontSize: 12,
    lineHeight: 1,
    scrollback: 0,
    disableStdin: true,
    cursorInactiveStyle: "none",
    theme: { background: getComputedStyle(root).getPropertyValue("--term-bg").trim() },
  });
  term.open(box);

  // WebGL keeps every glyph in its own cell, which matters for btop's braille graphs:
  // few fonts have braille, and a fallback font's wider dots would push the grid out
  try {
    const webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch (e) {}
  fit();
}

// Only width matters: fit() sets the height itself
let resizeTimer;
let lastWidth = 0;
new ResizeObserver(([entry]) => {
  const width = entry.contentRect.width;
  if (width === lastWidth) return;
  lastWidth = width;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(fit, 100);
}).observe(document.querySelector(".stage"));

// The server sends the homelab's palette as CSS; swapping it in recolours the page
function applyTheme(css) {
  if (!css) return;
  let style = $("palette");
  if (!style) {
    style = el("style");
    style.id = "palette";
    document.head.append(style);
  }
  if (style.textContent === css) return;
  style.textContent = css;
  if (term) term.options.theme = { background: getComputedStyle(root).getPropertyValue("--term-bg").trim() };
}

// ---------------------------------------------------------------- rendering

function renderTick(t) {
  $("uptime").textContent = uptime(t.uptime);
  $("watching").textContent = t.watching === 1 ? "1 (just you)" : t.watching;
}

let model = null;

function renderInfo(info) {
  if (info.model) {
    model = info.model;
    $("ask-model")?.replaceChildren(model);
  }
  if (info.requests) {
    $("requests").textContent = info.requests.total.toLocaleString("en-GB");
    $("rpm").textContent = `${info.requests.perMinute} req`;
  }

  if (info.containers.length) {
    $("containers").replaceChildren(...info.containers.map((c) => {
      const row = el("li");
      const usage = [c.cpu === null ? null : `CPU ${c.cpu.toFixed(1)}%`, c.mem === null ? null : bytes(c.mem, 0)]
        .filter(Boolean)
        .join(" · ");
      row.append(el("span", `state ${c.state}`), el("span", "name", c.name), el("span", "detail", c.status), el("span", "meta", usage));
      return row;
    }));
  }

  if (info.commits.length) {
    $("commits").replaceChildren(...info.commits.map((c) => {
      const row = el("li", "commit");
      const link = el("a", "name", c.subject);
      link.href = c.url;
      link.target = "_blank";
      link.rel = "noopener";
      row.append(el("span", "repo", c.repo), link, el("span", "meta", ago(c.time)));
      return row;
    }));
  }
}

// ---------------------------------------------------------------- ask

const askLog = $("ask-log");
const askForm = $("ask-form");
const askInput = $("ask-input");
// The last few turns go back with each question, so follow-ups make sense
const history = [];
let asking = false;

// Claude Code's status line: a spinning glyph and a verb while it works, then how long
const SPIN = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const VERBS = [
  ["Brewing", "Brewed"], ["Sautéing", "Sautéed"], ["Simmering", "Simmered"], ["Baking", "Baked"],
  ["Pondering", "Pondered"], ["Churning", "Churned"], ["Whisking", "Whisked"], ["Mulling", "Mulled"],
  ["Crunching", "Crunched"], ["Stewing", "Stewed"],
];
const clock = new Intl.DateTimeFormat("en-GB", { hour: "numeric", minute: "2-digit" });
const took = (ms) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

function statusLine() {
  const line = el("p", "ask-status");
  const spin = el("span", "spin", SPIN[0]);
  const text = el("span");
  line.append(spin, text);
  return { line, spin, text };
}

const helpText = () => `You are chatting with ${model || "a small local model"}, ask it something, and watch the CPU spike below.

You can:
- Ask anything
- Change the homelab's theme`;

// Only follow the answer down if the reader has not scrolled up to read something
function withScroll(update) {
  const atBottom = askLog.scrollHeight - askLog.scrollTop - askLog.clientHeight < 40;
  update();
  if (atBottom) askLog.scrollTop = askLog.scrollHeight;
}

askForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = askInput.value.trim();
  if (!question || asking) return;
  askInput.value = "";

  // Answered here, without troubling the model
  if (question.toLowerCase() === "/help") {
    withScroll(() => {
      askLog.querySelector(".ask-hint")?.remove();
      askLog.append(el("p", "ask-q", question), el("p", "ask-a", helpText()));
    });
    return;
  }
  asking = true;

  const [verb, done] = VERBS[Math.floor(Math.random() * VERBS.length)];
  const started = Date.now();
  const answer = el("p", "ask-a");
  const status = statusLine();
  let waiting = "";
  let frame = 0;
  const spinner = setInterval(() => {
    status.spin.textContent = SPIN[++frame % SPIN.length];
    status.text.textContent = waiting || `${verb}… (${took(Date.now() - started)})`;
  }, 120);

  withScroll(() => {
    askLog.querySelector(".ask-hint")?.remove();
    askLog.append(el("p", "ask-q", question), status.line);
  });
  history.push({ role: "user", content: question });

  let text = "";
  let tool = null;
  try {
    const response = await fetch("/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history.slice(-5) }),
    });
    if (!response.ok) {
      const { error } = await response.json().catch(() => ({}));
      throw new Error(error || "Something went wrong. Try again shortly.");
    }

    // One JSON object per line: a queue position, then the answer in pieces
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const data = JSON.parse(line);
        if (data.error) throw new Error(data.error);
        if (data.queue) waiting = `Queued · ${data.queue} ahead of you`;
        else if (data.queue === 0) waiting = "";
        // What the model did, in the same style as the status line
        if (data.tool) {
          tool = data.tool;
          const line = el("p", `ask-tool${data.tool.ok ? "" : " failed"}`);
          line.append(el("span", "mark", data.tool.ok ? "✓" : "✗"), el("span", "", data.tool.note));
          withScroll(() => status.line.before(line));
        }
        if (data.t) {
          text += data.t;
          withScroll(() => {
            if (!answer.isConnected) status.line.before(answer);
            answer.textContent = text.trim();
          });
        }
      }
    }
    if (!text) throw new Error("No answer came back. Try again shortly.");
    // The server needs the tool call back to show the model it really made it
    history.push({ role: "assistant", content: text.trim(), ...(tool && { theme: { colour: tool.colour, result: tool.result } }) });
    status.text.textContent = `${done} for ${took(Date.now() - started)} · done ${clock.format(new Date())}`;
  } catch (error) {
    history.pop();
    status.line.classList.add("error");
    status.text.textContent = error.message;
  }
  clearInterval(spinner);
  status.spin.textContent = "✻";
  asking = false;
});

// ---------------------------------------------------------------- stream

const status = document.querySelector(".status");
function setStatus(state, text) {
  status.dataset.state = state;
  $("conn").textContent = text;
}

let ready = null;

function connect() {
  const source = new EventSource("/events");

  source.addEventListener("init", (event) => {
    const data = JSON.parse(event.data);
    applyTheme(data.theme);
    renderTick(data.tick);
    renderInfo(data.info);
    setStatus("live", "Live · streaming from the homelab");

    // On a reconnect the old screen is replaced by the fresh snapshot
    ready = (async () => {
      if (!term) await createTerm(data.cols, data.rows);
      else term.resize(data.cols, data.rows);
      term.reset();
      term.write(decode(data.screen));
    })();
  });

  source.addEventListener("term", async (event) => {
    if (!ready) return;
    await ready;
    term.write(decode(event.data));
  });

  source.addEventListener("theme", (event) => applyTheme(JSON.parse(event.data).css));
  source.addEventListener("tick", (event) => renderTick(JSON.parse(event.data)));
  source.addEventListener("info", (event) => renderInfo(JSON.parse(event.data)));

  source.addEventListener("error", () => {
    ready = null;
    if (source.readyState === EventSource.CLOSED) {
      // Turned away (too many viewers, or the box is down): EventSource gives up
      // on a non-200 answer, so start again later
      setStatus("down", "Can't reach the homelab · trying again shortly...");
      setTimeout(connect, 30_000);
    } else {
      setStatus("down", "Connection lost · retrying...");
    }
  });
}

connect();
