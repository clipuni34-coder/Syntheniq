# Syntheniq — GitHub Codespaces RUNBOOK (iPhone, $0, no card)

One cloud computer that runs the **complete** Syntheniq pipeline — upload →
transcription (faster-whisper) → AI analysis (OpenAI/Gemini/heuristic) →
ClipPlan → HyperFrames render → FFmpeg → QC → 9:16 MP4 → download — reachable
from iPhone Safari through GitHub's HTTPS port forwarding. No card, no domain,
no Tailscale, no code changes: the product runs exactly as built.

**What this is:** a personal Syntheniq workstation you open when you edit.
**What it is not:** a 24/7 always-on server. (No $0 no-card platform can run
this workload and stay awake all the time — see "Honest limits" below.)

---

## One-time setup (do this BEFORE creating the codespace)

### 1. Add your AI keys as Codespaces secrets (account level!)

The repo is **public**, so repo-level codespace secrets would be visible to
anyone who creates a codespace from this repo. Use **account-level** secrets
instead (only yours):

1. github.com → ⚙ Settings → **Codespaces** (left menu) → **Secrets**
2. Add:
   - `OPENAI_API_KEY` = your key
   - `GEMINI_API_KEY` = your key
3. Done. GitHub injects them into your codespace as environment variables
   (server-side only — never in git, never in the browser, never in logs).

Secrets are applied when a codespace is **created**, so add them before the
first creation (or recreate the codespace after adding).

No keys is also fine: the app boots and runs in **heuristic (offline) mode** —
startup never fails for missing keys.

---

## Start Syntheniq

1. Safari → **github.com** → sign in (if not already).
2. Open the **clipuni34-coder/Syntheniq** repository.
3. Tap the **Codespaces** tab → **New codespace**.
4. Branch: **`deploy/codespaces`**.
5. Machine size: pick the smallest enabled one — the devcontainer enforces a
   minimum of **4 cores / 8 GB / 32 GB** (smaller options are greyed out).
   This matches the measured workload (render stages peak ~1.5–2 GB RAM).
6. Wait. **First creation takes ~5–15 minutes**: GitHub builds the devcontainer
   (Node 22, FFmpeg with drawtext, faster-whisper + the 460 MB `small` model,
   HyperFrames CLI + its headless Chrome, then builds the app). GitHub caches
   this per commit — later recreations from the same commit are much faster.
7. When it's ready, open the **Ports** tab → **port 3000 — "Syntheniq"** →
   **Open on phone** (or copy the URL). It looks like:

   `https://3000-clipuni34-coder-syntheniq-deploy-codespaces.github.dev`

   (GitHub shows the exact URL for your codespace in the Ports tab.)
8. The URL first shows the **GitHub login** (you're already signed in on
   Safari), then Syntheniq. Enter the passcode: **`syntheniq-2026`**
   (changeable — see "Changing the passcode" below).
9. **Done.** Upload a video from Photos, wait for processing, download clips.

The server starts automatically when the codespace is created. The forwarded
port gives you HTTPS for free — no domain, no DNS, no configuration.

---

## Stop / resume (so you don't burn the free allowance)

- **Stop** (codespace page → Stop): the machine hibernates. **Core-hours stop
  counting**; only storage (≤15 GB-month included) is billed. Resume with
  **Start** — wakes in ~1–3 minutes.
- **Idle hibernation** (GitHub default, 30 minutes of inactivity): the
  codespace auto-hibernates. Next visit wakes it. If a long render gets
  hibernated mid-flight, the job is marked *interrupted* — hit **Retry** in
  the UI and it resumes from the last completed stage. No data is lost.
- Practical habit: **open → edit → download your clips → Stop.**

## Changing the passcode

Codespaces secrets (account level) → add `SYNTHENIQ_PASSWORD` = your passcode,
then recreate the codespace. (The startup script only sets a default when the
variable is unset.)

## Adding keys later / without secrets

Open a **terminal** inside the codespace (⋯ → Open a terminal) and run:

```
nano ~/.syntheniq.env
```

paste `OPENAI_API_KEY=...` / `GEMINI_API_KEY=...` lines, save. Then in the
Codespaces UI, restart the terminal session and run
`bash /repo/scripts/start-codespaces.sh` (or recreate the codespace). The file
lives outside the repo — it is never committed. Real environment variables
(Codespaces secrets) always take precedence over the file.

---

## Usage & cost — the actual current GitHub numbers (verified, Sept 2026)

| Item | Value |
|---|---|
| Free personal allowance | **120 core-hours + 15 GB-month per month** (180 core-hours with the GitHub Student Pack, if you are a verified student) |
| A 4-core/8 GB machine | 4 core-hours per hour → **≈ 30 machine-hours per month** free (≈ 45 with Student Pack) |
| A 2-core/4 GB machine | 60 machine-hours free — *below this project's minimum, not selectable here* |
| Payment card | **Not required.** With no payment method on file, GitHub **blocks** Codespaces usage once the free allowance is used — it does not charge. This is the $0 guarantee. |
| Overage pricing | $0.18/core-hour, $0.07/GB-month — **never applies while no card is on file** (usage is blocked instead) |
| Storage | 32 GB disk on 2/4-core machines; stopped codespaces count toward the 15 GB-month |

You can watch usage in the codespace view (core-hours + GB used this month).

---

## Honest limits (read once)

1. **Not always-on.** First visit after hibernation takes ~1–3 minutes to
   wake. That is the price of $0 + no card for this workload; nothing is
   crippled to fit it.
2. **Inactivity retention:** GitHub auto-deletes codespaces unused for the
   retention period (default **30 days**, chosen at creation — you can pick
   1/7/30 days). Deletion wipes the data disk. **Download finished clips to
   your iPhone when you're done.** Treat this as a working machine, not
   archival storage — the app's own persistence (uploads, clips, job state,
   crash recovery) works normally while the codespace exists.
3. **Long renders:** typical renders are 8–13 minutes. If one runs longer
   than ~25 minutes while you're not touching the UI, idle hibernation can
   interrupt it → Retry resumes it (crash-recovery is built in and tested).
   Interacting with the UI keeps the codespace awake.
4. **Disk budget:** 32 GB shared — runtime stack ≈ 3 GB, each project
   0.5–1.5 GB (long sources use more). Delete old projects from the UI when
   the disk fills; the app refuses new work rather than corrupting files.
5. **AI keys:** OpenAI/Gemini calls need network + your keys (secrets).
   Without keys, the heuristic fallback produces the full pipeline, minus
   AI editorial intelligence.

---

## When something looks broken (rare)

Open a terminal inside the codespace:

```
tmux attach -t syntheniq            # live server log  (Ctrl-B, then D to leave)
bash /repo/scripts/start-codespaces.sh          # full preflight + restart
bash /repo/deploy/codespaces/verify.sh          # the 20-check acceptance test
```

`verify.sh` proves the whole pipeline end-to-end in the codespace (real
transcription, real render, real QC, real MP4, crash-recovery) in ~25–45
minutes. If any check fails, stop and report it — don't weaken the product.

## What was built (additive only)

- `.devcontainer/devcontainer.json` — enforces ≥4 cores/8 GB/32 GB, forwards
  port 3000, auto-starts the server
- `.devcontainer/Dockerfile` — the production Dockerfile's environment, built
  natively (Codespaces have no Docker daemon — same packages, same versions)
- `scripts/start-codespaces.sh` — one command: verify every binary, load
  env/secrets, start the server on 0.0.0.0
- `deploy/codespaces/verify.sh` — 20-check acceptance test
- `deploy/codespaces/RUNBOOK.md` — this file

No product code was modified. `deploy/persistent` is untouched.
