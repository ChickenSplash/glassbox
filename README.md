# Glass box

A live page showing the vitals of the homelab that serves it: CPU, memory, temperature,
network, disk, containers, portfolio traffic and recent commits, streamed once a second.

- **Backend:** Node.js 22, no dependencies. One sampler reads `/proc` and `/sys` every
  second and fans the same frame out to every viewer over Server-Sent Events.
- **Frontend:** plain HTML, CSS and JavaScript. Charts are hand-drawn on `<canvas>`.
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
