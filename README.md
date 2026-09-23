# Glass box

A live page for the homelab that serves it: the real btop, mirrored to every visitor,
plus its containers, portfolio traffic and recent commits.

- **btop:** runs in its own container on a pty (via `socat`) and is served over a unix
  socket that only the app mounts. Host networking so its net box sees the real NIC.
  The process box is off, and IPv4 addresses are masked before anything leaves the box.
- **App:** Node.js 22. One connection to btop, fanned out to every viewer over
  Server-Sent Events, gzip-flushed per frame. A headless xterm.js keeps a copy of the
  screen so new viewers start from the current picture.
- **Frontend:** plain HTML, CSS and JavaScript, with xterm.js and its WebGL renderer.
- **Docker:** reached only through [wollomatic/socket-proxy](https://github.com/wollomatic/socket-proxy),
  allowlisted to listing containers and reading their stats.
- **Traffic:** the portfolio's nginx `stub_status`, on a port only the Docker network can reach.
- **Commits:** `git log` over read-only mounts of each repo's `.git` directory.

## Run

```sh
docker compose up -d --build
```

It joins the external `edge` network created by the cloudflared stack. Point a tunnel
public hostname at `http://glassbox:8080`.

The socket proxy runs as group `961`, the host's `docker` group. Check yours with
`getent group docker` and change `user:` in `docker-compose.yml` to match.
