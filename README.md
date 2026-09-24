# Glass box

A live page for the homelab that serves it: the real btop, mirrored to every visitor,
plus its containers, own traffic and recent commits, and a chat box answered by a
small model on the same CPU.

- **btop:** runs in its own container on a pty (via `socat`) and is served over a unix
  socket that only the app mounts. Host networking so its net box sees the real NIC.
  The process box is off, and IPv4 addresses are masked before anything leaves the box.
- **App:** Node.js 22. One connection to btop, fanned out to every viewer over
  Server-Sent Events, gzip-flushed per frame. A headless xterm.js keeps a copy of the
  screen so new viewers start from the current picture.
- **Frontend:** plain HTML, CSS and JavaScript, with xterm.js and its WebGL renderer.
- **Docker:** reached only through [wollomatic/socket-proxy](https://github.com/wollomatic/socket-proxy),
  allowlisted to listing containers and reading their stats.
- **Traffic:** counts requests reaching the glassbox app, with a rolling 60-second
  window. Health checks and HEAD requests are ignored; Cloudflare-cached assets
  never reach the app. The total resets when the app restarts.
- **Commits:** `git log` over read-only mounts of each repo's `.git` directory.
- **Ask the homelab:** [llama.cpp](https://github.com/ggml-org/llama.cpp) serving Qwen3.5-4B
  (Q4_K_M) on the CPU, on an internal network only the app can reach. The app queues
  questions (one answer at a time), rate-limits per visitor and streams the reply. The
  model gets [`ask/facts.md`](ask/facts.md) for details about Emanuel and his projects.
  Its tone and conversational rules are in [`ask/prompt.md`](ask/prompt.md). Both files
  are read on every question, so edits to either apply without a rebuild; the app
  re-warms the model's prompt cache when they change.
- **Themes:** visitors can ask the chat for a new colour. The model calls a `set_theme`
  tool limited to the presets in [`themes/`](themes), each generated from a seed colour
  in `themes/seeds.json` by `themes/make-presets` (matugen plus DankMaterialShell's
  dank16, so it runs on a desktop; commit the output). The app only writes the chosen
  name to a mounted `choice/` directory, and the homelab's own `theme-apply` recolours
  btop, the page and the rest of the machine from it. One change a minute overall,
  and one per visitor every 10 minutes.

## Run

Fetch the model first (about 2.7 GB, not in git):

```sh
mkdir -p models
curl -L -o models/Qwen3.5-4B-Q4_K_M.gguf \
  https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf
docker compose up -d --build
```

It joins the external `edge` network created by the cloudflared stack. Point a tunnel
public hostname at `http://glassbox:8080`.

The socket proxy runs as group `961`, the host's `docker` group. Check yours with
`getent group docker` and change `user:` in `docker-compose.yml` to match.
