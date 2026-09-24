# Facts for "Ask the homelab"

Facts about Emanuel and his projects. For behaviour and personality, edit prompt.md.
Public repo: keep it to things you are happy to publish.
Read on every question, so edits apply straight away with no rebuild.

## Emanuel
- Emanuel Correia, full-stack web developer based in Norfolk, UK.
- Works mostly in Laravel and PHP. Likes tidy backends, fast interfaces, and self-hosting what he makes on a small homelab.
- Developer at Premier Education Group. Works on the business management system, the learning platform and the public website that keep the company running. Day to day: Laravel, Livewire, Filament and a lot of AI.
- Outside work: containerised side projects behind a Cloudflare tunnel, Linux setups tuned far more than they need to be, Blender scenes, and the odd game or VR world.

## What he does
- Web applications: Laravel apps from database design to admin panels, APIs and the front end.
- Interfaces: clean, responsive UIs with Livewire, React, TypeScript, and plain CSS when that is enough.
- Infrastructure: Docker, reverse proxies and self-hosted services on Linux, kept simple and reproducible.

## Toolbox
PHP, Laravel, Livewire, Filament, JavaScript, TypeScript, React, SASS, MySQL, Docker, Linux, Python, C# .NET, Lua, Blender.

## Projects
- Business Management System: the core internal platform at Premier Education, with admin, portals and a public API. Laravel, Filament, Livewire.
- Learning Zone: a learner-facing LMS with its own admin, built on the latest Laravel stack. Laravel, Volt, Flux UI.
- Projects Panel: a self-hosted dashboard where people post projects as links, with a private gratitude journal alongside. Runs on this homelab at chickensplash.dpdns.org. Laravel 13, Livewire 4 (Volt), Tailwind CSS 4, SQLite. It also receives the portfolio's contact form messages.
- Portfolio: his personal site at portfolio.chickensplash.dpdns.org, served by nginx on this homelab.
- Glass box: this page, lab.chickensplash.dpdns.org. Mirrors the homelab's real btop to every visitor live, plus its containers, glassbox request counts and recent commits. Node.js, Server-Sent Events, xterm.js. Source: github.com/ChickenSplash/glassbox.

## The homelab (you)
- A Dell OptiPlex 3060 Micro, headless in a cupboard under the router in Norfolk, UK.
- Intel Core i5-8500T (6 cores), 8 GB DDR4, 250 GB SSD, CachyOS Linux (Arch-based) on btrfs.
- Everything runs in Docker. No open ports: traffic arrives through an outbound Cloudflare tunnel.
- Hosts the portfolio (nginx), Projects Panel and this page. Emanuel runs it from his desktop over the LAN, and it can be woken remotely if it's switched off.
- Everything on the box shares one colour theme: this page, btop, the terminal and the editor. When a visitor changes the theme, a small script re-colours them all and open pages update live for everyone.

## How this page works
- Four containers: the Node.js app, a real btop streamed to your browser through xterm.js, a locked-down Docker socket proxy for the container list, and me, the chat model.
- Live stats arrive by Server-Sent Events.
- Twelve theme presets (red, orange, amber, yellow, lime, green, teal, cyan, blue, indigo, purple, pink), generated from seed colours with Material You-style colour tooling.

## This chat (you)
- Qwen3.5-4B, 4-bit, served by llama.cpp on the CPU with 5 threads and about 2 GB of RAM. No GPU.
- About 4 words a second, so replies take 7 to 10 seconds, and theme changes a bit longer.
- On a private network only this page can reach. Questions are not stored.

## Contact
- Contact form on the portfolio: portfolio.chickensplash.dpdns.org/#contact
- Email: guardeded@gmail.com
- GitHub: github.com/ChickenSplash
- LinkedIn: linkedin.com/in/emanuel-correia-993173370
