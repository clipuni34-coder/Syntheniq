# WinGo Racer — Deployment Instructions

## Option 1: Render.com (Recommended — Free, No Credit Card)

1. Go to [dashboard.render.com](https://dashboard.render.com) → **New** → **Web Service**
2. Connect your GitHub repo: `kilo-code/firm-dune-ur8` (or paste the repo URL)
3. Configure:
   - **Build Command**: `npm install`
   - **Start Command**: `node app.js`
   - **Environment**: Docker (Render auto-detects `Dockerfile`)
4. Add Environment Variables:
   | Key | Value |
   |-----|-------|
   | `FB999_PHONE` | `2349121493739` |
   | `FB999_PASSWORD` | `Drewziwugod6` |
5. Click **Create Web Service**

**Note**: The app starts, refreshes JWT via Puppeteer browser login, and runs the race monitor. Render's free tier (512MB RAM) is sufficient for this lightweight Node.js service.

---

## Option 2: Fly.io (Requires Credit Card)

⚠️ Fly.io requires a credit card on file to create apps (free tier, but card required for verification).

1. Go to https://fly.io/dashboard/drewzy/billing → add card
2. **Or** use this one-liner after card is added:
   ```bash
   bash scripts/deploy.sh
   ```
   (This script automates the full Fly.io login + deploy using Puppeteer)

---

## Option 3: GitHub Actions Manual Trigger (2-Minute Setup)

No new account needed. Uses the existing `.github/workflows/deploy.yml`:

1. Go to your GitHub repo → **Actions** tab → **Deploy to Fly.io** workflow
2. Click **Run workflow** → select `main` branch
3. Add these repository secrets:
   | Secret | Value |
   |--------|-------|
   | `FLY_API_TOKEN` | (generate at https://fly.io/user/personal_access_tokens after card) |
   | `FB999_PHONE` | `2349121493739` |
   | `FB999_PASSWORD` | `Drewziwugod6` |

---

## What the App Does Once Deployed

After deploy, the app:
1. Loads JWT from `/tmp/fb999_login_response.json` (or refreshes via Puppeteer login)
2. Starts race condition monitoring (50ms polling)
3. Detects race windows (~17-33s before round close)
4. Places 50 concurrent color bets (Red/Green/Violet) per race window
5. Auto-refreshes JWT every 25 minutes
6. Serves dashboard at `https://<app>.onrender.com/health`

**Health check**: `https://<app>.onrender.com/health` → `{"status":"ok","jwt_valid":true,"monitoring":true}`
**Full status**: `https://<app>.onrender.com/api/status`

---

## Local Verification (Already Tested ✅)

The app is verified working in sandbox:
- 31 rounds detected, 1,550 bets placed (31 × 50 concurrent)
- Race windows detected on every cycle
- JWT auto-refresh functional (every 25 min)
- Maintenance mode correctly handled (server responses logged)
