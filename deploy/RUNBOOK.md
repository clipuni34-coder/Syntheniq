# Syntheniq — Deployment Runbook
For the existing, verified app at `dev/finish-pipeline` (baseline `e9bbae9`,
deploy branch cut from `b7b162c`). No product code is modified by deployment.

## The 60-second version
```bash
# on an always-on Linux machine (x86-64 or ARM64), with Docker + Tailscale
bash deploy/bootstrap.sh            # install Docker/Tailscale if missing,
#   → edit the .env it creates (your AI keys + passcode), re-run
#   → it builds, starts, and publishes https://syntheniq.<tailnet>.ts.net
```
Then on your iPhone: free **Tailscale** app → log in with the same account →
**Safari** → that URL → passcode. No domain, no port forwarding, no router
config. Works on mobile data.

---

## Option 1 — your always-on home machine (recommended, $0)
Works on: x86-64 PC, Intel NAS, Ubuntu/Debian server box. Also macOS (see
below) and Windows (manual steps; Docker Desktop + Tailscale app + the
`tailscale serve` CLI in PowerShell — Serve is best-supported on Linux/macOS,
so for Windows prefer a Linux VM or a NAS).

**x86-64 Linux (one-shot):**
```bash
bash deploy/bootstrap.sh     # then: edit ~/syntheniq/.env, re-run
```
**ARM64 Linux (e.g. Raspberry Pi 5, Apple-in-Linux, Ampere box):** the
bootstrap auto-detects the arch and builds with `INSTALL_CHROMIUM=1`
(Chrome-for-Testing publishes no linux/arm64 browser; Debian's chromium is
used instead — verified approach, HyperFrames' `HYPERFRAMES_BROWSER_PATH`
hook).

**macOS (manual):**
1. Install Docker Desktop + the Tailscale app (both free).
2. Intel Mac: `docker compose up -d --build`
3. Apple Silicon (M1/M2/M3/M4): run the standard x86-64 image under
   Rosetta/QEMU emulation — easiest, one image for everything:
   ```bash
   docker buildx build --platform linux/amd64 -t syntheniq .
   docker compose up -d
   ```
   (native arm64 build also works: `docker buildx build --platform
   linux/arm64 --build-arg INSTALL_CHROMIUM=1 -t syntheniq .`)
4. `sudo tailscale serve --bg --https 443 127.0.0.1:8787`
5. `tailscale serve status` → your URL.

## Option 2 — Oracle Cloud Always Free VM (fallback, $0 within limits)
Only if you don't have an always-on machine.
1. Oracle Cloud account (card verification; signups can need a couple of
   attempts; the free tier itself never expires).
2. Create an **A1.Flex** VM (Ubuntu 22.04/24.04). Free-tier allowance since
   2026-06-15: **2 OCPU / 12 GB** (was 4/24; new free accounts may be
   UI-capped at 1/6 — 2/12 is comfortable, 1/6 workable for 720p). If A1
   capacity won't allocate for a free account, the documented route is a
   Pay-As-You-Go account (card on file; usage within the free allowance
   stays $0 — set a cost alert).
3. ~50–100 GB boot volume (200 GB free block storage).
4. On the VM: `bash deploy/bootstrap.sh` (ARM64 path auto-selected).
5. Same iPhone steps. The VM's public IP is never exposed — only Tailscale
   reaches the service.

## Option 3 — NOT recommended (honest limitations)
- **Render free tier**: 512 MB RAM / 0.1 CPU, sleeps after 15 min, **no
  persistent disk**, 750 h/mo → renders OOM, in-flight renders die on sleep,
  uploads vanish on redeploy. Not viable for this product.
- **Fly.io / Railway**: no true $0 always-on tier. **Heroku**: free tier
  removed. **GCP e2-micro / AWS free**: 1 GB RAM — insufficient.

---

## What to verify after first boot (the gates)
```bash
docker compose exec syntheniq sh -c "ffmpeg -filters | grep -c drawtext"        # expect ≥1
docker compose exec syntheniq sh -c "ls /root/.cache/hyperframes/chrome" || true # chrome present (x86)
docker compose exec syntheniq sh -c "cd /repo/apps/api && \
  node test/openai-client.mjs && node test/regression.mjs && \
  node test/failover-check.mjs && node test/model-routing.mjs"                  # 66/66
```
Then the real test: **from your iPhone** — upload a real video → watch all
stages (analyze/plan/render/QC) → download a clip. Then the crash test:
```bash
docker compose kill          # mid-idle is fine
docker compose up -d
# any in-flight job shows 'interrupted' → tap Retry in the UI → completes
```

## Operations
| Task | Command |
|---|---|
| Logs | `docker compose logs -f` |
| Restart | `docker compose restart` |
| Update (after `git pull`) | `docker compose up -d --build` |
| Stop (data kept) | `docker compose down` |
| Erase everything | `docker compose down -v` (careful!) |
| Data location | volume `syntheniq_syntheniq-data` → `/data` inside the container |
| Backup data | `docker run --rm -v syntheniq_syntheniq-data:/d -v ~/backup:/b alpine tar czf /b/syntheniq-$(date +%F).tar.gz -C /d .` |
| Check storage | `docker system df` |

## Failure / restart behavior (what to expect)
- **Close Safari / phone offline**: nothing stops — jobs run in the container.
- **Machine reboot / power cut**: Docker daemon + container come back
  (`restart: unless-stopped`); Tailscale Serve URL is the same; any in-flight
  job is marked `interrupted` at boot (existing crash-consistency) and is
  retriable. Files never lost.
- **Power-cut mid-render** (common with unstable power): same as above — the
  clip re-renders on retry. Use a UPS/inverter for the machine if possible.
- **Image rebuild**: data volume untouched; in-flight jobs (if any) become
  retriable.
- **First render after a rebuild** on x86-64: instant (chrome baked in); on
  ARM: instant (chromium in the image).

## Troubleshooting
- **"Chrome binary not found"** in logs → x86-64 image: rebuild
  (`docker compose up -d --build`); ARM image: confirm it was built with
  `INSTALL_CHROMIUM=1`.
- **Render hangs ~40 min / "Failed to launch browser Code: null"** → partial
  chrome install: rebuild the image (it re-runs `browser ensure` / installs
  chromium fresh).
- **OOM kills during render** (check `docker inspect syntheniq | grep -i oom`
  or host `dmesg`) → raise `mem_limit` in docker-compose.yml; the machine
  needs ~8 GB free for 1080p60.
- **iPhone can't reach the URL** → Tailscale app on the phone: is it online?
  Same account as the server? `tailscale status` on the server: is Serve
  listed? (`tailscale serve status`.)
- **Slow on Apple Silicon** → you're in amd64 emulation (normal); the ARM64
  native build (`--platform linux/arm64 --build-arg INSTALL_CHROMIUM=1`) is
  faster.
- **Disk filling up** → old projects: delete from the UI, or
  `docker compose exec syntheniq sh -c "ls -la /data"` and prune, then
  `docker system prune -f` for build cache.

## Secrets
- Keys live ONLY in `~/syntheniq/.env` (chmod 600, gitignored). The browser
  never sees them (same-origin API; `/v1/config` returns settings, not keys).
- The GitHub repo is public — never paste real keys into it or into a commit.
