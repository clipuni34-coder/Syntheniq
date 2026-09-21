# Syntheniq on GitHub Codespaces — iPhone RUNBOOK

Everything below was measured on a real codespace (4-core/16 GB) running
this exact branch. Numbers are official GitHub figures; behavior notes are
from live testing.

---

## What already works for you (verified 2026-09-21)

- App boot, web UI, passcode login — ✓
- Whisper transcription of real speech — ✓ (`small`, int8, pre-downloaded)
- Full pipeline source → transcribe → analyze → plan → render → package → QC → done — ✓
- Real HyperFrames render, 1080×1920 (9:16), with auto-repair variant — ✓
- 45 MB source video imported and processed end-to-end — ✓
- Crash-safe data + auto-start after hibernate/resume — ✓

---

## 1. One-time setup (later)

**API keys (optional but recommended — heuristic fallback works without them):**
GitHub → your avatar → Settings → Codespaces (left menu) → codespaces Secrets
→ **New secret**, twice:

| Secret name            | Value                |
|------------------------|----------------------|
| `OPENAI_API_KEY`       | your OpenAI key      |
| `GEMINI_API_KEY`       | your Gemini key      |

Use **account-level** Codespaces secrets (the repo is public — never put keys
in the repo). After adding, **restart the codespace** once so it picks them up.

---

## 2. Daily use — the only steps you need

1. Open `https://github.com/codespaces`
2. Tap your codespace (name like `legendary-robot-…`) — it wakes up
   (if it shows **Shutdown**, tap ⋯ → **Resume**; that's normal, ~30 s).
3. Wait ~60–90 s — the app restarts by itself (no terminal needed).
4. Open the app URL in Safari:

   ```
   https://<your-codespace-name>-3000.app.github.dev
   ```

   (example: `https://legendary-robot-p7px9r4vxq9qcr49q-3000.app.github.dev`)

5. Passcode: **`syntheniq-2026`**
6. Upload / process / download your clips (they arrive in iPhone Downloads).

When finished, just close the tabs. The codespace sleeps on its own after
~30 idle minutes — sleep mode still eats into **storage**, not compute.

---

## 3. Uploading videos — pick the lane by size

GitHub's port tunnel rejects browser uploads over ~16–24 MB (measured; the
server itself allows 512 MB). Two lanes, both no-terminal:

**A. Small videos (< ~15 MB)** — use the app UI "Upload" button. Done.

**B. Long/big videos (> ~15 MB)** — upload them into the `inbox/` folder
with the codespace editor, and they auto-import in ~10 s:

1. Open the codespace editor URL in Safari:

   ```
   https://<your-codespace-name>.github.dev
   ```

2. Left sidebar → **Explorer** (top icon, the two pages).
3. Tap the file tree's root (`Syntheniq`) → in the top bar of the tree,
   tap the **"⋯ " (More)** menu → **Upload…**..
   (On iPhone you can also long-press the `inbox` folder → **Upload…**..)
4. Pick your video from Files/Photos. It streams straight onto the box —
   no ~20 MB cap (45 MB verified end-to-end; larger should work, watch the
   upload spinner in the editor's status area until it finishes).
5. Done — the upload appears in the Syntheniq app as a new project within
   ~10 seconds; from there everything is automatic.

Behind the scenes a watcher (`scripts/inbox-watcher.sh`) moves originals to
`inbox/.done/` after a clean handoff — you can ignore that folder.

---

## 4. The forwarded-URL mechanics (why the URL looks like that)

- Syntheniq listens on `0.0.0.0:3000` inside the codespace.
- GitHub exposes it publicly at `https://<name>-3000.app.github.dev`.
- We set this port's visibility to **Public** so Safari opens it directly.
  Anyone with the full URL still needs the Syntheniq passcode — keep the
  URL private. To re-harden: in the editor → PORTS panel → right-click the
  3000 row → Port Visibility → Private (then GitHub login is also required).
- The editor URL (`<name>.github.dev`, no `-3000`) is the VS Code web view
  (Explorer/terminal — needed only for the inbox upload of big files).

---

## 5. Free allowance reality (official GitHub numbers)

| Resource                     | Free personal account                          |
|------------------------------|-------------------------------------------------|
| Core-hours / month           | 120 (4-core ⇒ ~30 h of RUNNING time)           |
| Storage-month                | 15 GB-month (over → usage blocked, not billed) |
| Idle timeout                 | 30 min default (auto-stops; resumable)         |
| Inactive codespace deletion  | 30 days (download clips when done!)            |
| Machine sizes                | 2c/8 GB · **4c/16 GB (recommended)** · bigger  |
| Payment method               | **None needed — with no card, usage BLOCKS at  |
|                              | quota instead of billing. $0 guaranteed.**     |

Watch your spend: github.com/settings/billing → “Codespaces” shows live
core-hours and storage used this month.

## 6. Housekeeping to protect the quota

- Keep **only one** codespace — each stopped machine still counts its 32 GB
  against storage until deleted.
- Delete old/broken ones: `github.com/codespaces` → ⋯ → **Delete**.
  (Your projects are inside the surviving one; deleting another does NOT
  touch it.)

---

## 7. If something looks wrong

| Symptom                                    | Fix |
|--------------------------------------------|-----|
| URL gives 404                              | Codespace is stopped → resume it from github.com/codespaces, wait 90 s. |
| URL loads Safari "download…" dialog        | You’re inside another app’s in-app browser → open in real Safari instead. |
| Passcode rejected                          | It was overridden by a `SYNTHENIQ_PASSWORD` secret — use that value. |
| Upload bar dies on big file                | Use Lane B (inbox via editor Explorer) — tunnel cap, not your fault. |
| Processing stuck                           | In the app: project → details → retry (existing crash-resume). Or resume the codespace → it auto-restarts. |
| Still stuck                               | Message me with: what you tapped + exact error text. |

---

## Today's verified configuration

- Branch: `deploy/codespaces` (built from production-ready product @ `b7b162c`)
- `.devcontainer/devcontainer.json` — build context `..`, remoteUser `node`,
  hostRequirements 4c/8GB+, postCreate + **postStart** auto-boot, sshd feature
- `.devcontainer/Dockerfile` — Node 22 · Debian ffmpeg + drawtext ·
  faster-whisper + `small`/int8 baked · edge-tts · HyperFrames CLI +
  chrome-headless-shell · app static build · `tmux`
- `scripts/start-codespaces.sh` — preflight + env handling +
  `0.0.0.0:3000` + **inbox watcher** launch
- `scripts/inbox-watcher.sh` — long-video auto-import lane (uses existing API)
- `deploy/codespaces/verify.sh` — 20-check acceptance (20/20 passed with a
  real render + kill-9 recovery in a cloud-VM sandbox on this tree)
- Zero product-code changes anywhere.
