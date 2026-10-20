# OpusClip / RENA Reverse Engineering Report

## 1. Target Identification

**Application**: OpusClip (clip.opus.pro) — AI-powered video repurposing platform
**Type**: SaaS web application (Next.js + Turbopack frontend, NestJS backend)
**Date**: 2026-10-19
**Status**: Analysis complete (unauthenticated access only)

---

## 2. Domain & Endpoint Inventory

### 2.1 Core Domains

| Service | Domain |
|---------|--------|
| Main App | `https://clip.opus.pro` |
| API Gateway | `https://api.opus.pro/api` |
| Auth0 | `https://auth.opus.pro` |
| API Gateway (alt) | `https://api-gateway.opus.pro/api` |
| Lane Preview | `https://lane-preview.eng.opus.pro` |
| Lanes API (prod) | `https://lanes-api.eng.opus.pro/api` |
| Lanes API (staging) | `https://stg-lanes-api.eng.opus.pro/api` |
| Agent Service | `https://agent.opus.pro/` |
| AI Producer | `https://producer.opus.pro/` |
| Labs | `https://labs.opus.pro/` |
| Admin Panel | `https://admin.opus.pro` |
| Workflow Engine | `https://{env}.eng.opus.pro/namespaces/opus/workflows` |
| Help Docs | `https://help.opus.pro` |
| Affiliates | `https://affiliates.opus.pro` |

### 2.2 Environment Variables & Build Info

- **Framework**: Next.js 15.x with Turbopack (development build identifier visible in bundles)
- **React Version**: 18 (inferred from bundles)
- **Jotai State Management**: v2.20.0 (`jotai@2.20.0_@babel+core@7.29.7`)
- **Production Build ID**: `production` mode confirmed
- **Debug Portal**: Default height 500px, tabs include: ARC_CHAT, AUTH, BRAND_TEMPLATE, BRAND_KIT, CAMPAIGN_LANDING, CLIP, CLIP_EDIT, DASHBOARD, WORKFLOW, FREE_TOOL, FREE_TOOL_PROJECT, JOIN_TEAM, SUBSCRIPTION, SEARCH, LOGIN, CALENDAR, FSC, OMNI

---

## 3. Authentication System

### 3.1 Auth0 Configuration

**Source**: `/tmp/opus_js/11_0k0l7jwulg.js` (module 177275) and `/tmp/opus_dashboard/11_0k0l7jwulg.js`

| Parameter | Value |
|-----------|-------|
| Domain | `https://auth.opus.pro` |
| Auth0 API | `https://opuspro.us.auth0.com` |
| Client ID | `ykTnDeep3yBiWEr5ugt04fpYDIoiOtrY` |
| Authorization Endpoint | `https://opuspro.us.auth0.com/authorize` |
| Token Endpoint | `https://opuspro.us.auth0.com/oauth/token` |
| Userinfo Endpoint | `https://opuspro.us.auth0.com/userinfo` |
| JWKS URI | `https://opuspro.us.auth0.com/.well-known/jwks.json` |
| Audience | `https://opuspro.us.auth0.com/api/v2/` |
| Scope | `openid profile email` |
| Redirect URI | `${window.location.origin}/auth/callback` |
| Cache Location | `localstorage` |
| Session Check Expiry | 7 days |
| SDK | Auth0 SPA SDK (`auth0-spa-js`) |

### 3.2 Cookie Configuration

```javascript
function ik(e){return{
  expires: 30,
  sameSite: "lax",
  ...(e === "opus.pro" || e.endsWith(".opus.pro") ?
    {domain: ".opus.pro", secure: true} : {})
}}
```

- Cookie name: `opus_current_org`
- Domain: `.opus.pro`
- SameSite: Lax
- Secure: true (for opus.pro domains)
- Expiry: 30 days

### 3.3 Cloudflare Turnstile

- **Provider**: Cloudflare Turnstile (anti-bot)
- **Site Key**: `0x4AAAAAAEXb6Wm1YMBksOrz`
- **Script URL**: `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`
- **Token Header**: `x-opus-turnstile-token`
- **Actions**:
  - OTP login: `action: "otp-login"`, `appearance: "interaction-only"`, `execution: "render"`
  - Timeout callback: 60 seconds (interactive) / 15 seconds (non-interactive)
  - Token expiry: 240 seconds

### 3.4 Auth Flow

```
1. User visits clip.opus.pro → redirected to /auth/oauth/login
2. Auth0 OAuth: loginWithRedirect() → user redirected to opuspro.us.auth0.com/authorize
3. After Auth0 authentication, tokens are stored in localStorage
4. Token exchange: Auth0 access token is used as subject_token in:
   POST https://opuspro.us.auth0.com/oauth/token
   Grant type: urn:ietf:params:oauth:grant-type:token-exchange
   Response includes id_token (internal user/org token)
5. JWT is decoded (base64 payload) to extract:
   - userId (from orgToken.current.userId)
   - orgId (from orgToken.current.orgId)
   - loginId (from JWT sub claim)
6. Tokens cached in Zustand/Jotai schedulers:
   - userTokenScheduler: caches user bearer token
   - orgTokenScheduler: caches {current: {userId, orgId}, orgList: [...]}
```

### 3.5 Social Login Providers

- Google (WorkOS integration)
- Apple
- Facebook
- SSO (SAML/OIDC connections)

### 3.6 Auth0 Grant Types Supported

```javascript
let eA = ["authorization_code", "refresh_token", 
          "urn:ietf:params:oauth:grant-type:token-exchange",
          "http://auth0.com/oauth/grant-type/mfa-oob",
          "http://auth0.com/oauth/grant-type/mfa-otp",
          "http://auth0.com/oauth/grant-type/mfa-recovery-code"]
```

### 3.7 Token Exchange Endpoint (Key Finding)

**Endpoint**: `POST https://api.opus.pro/api/auth/grant-free-tool-credential`

This endpoint provides **guest/unauthenticated access tokens** for tool usage:

```bash
POST https://api.opus.pro/api/auth/grant-free-tool-credential
Content-Type: application/json
X-OPUS-DEVICE-PLATFORM: web
{
  "data": {
    "loginId": "guest_yRVbBJXwlK",
    "orgId": "guest_yRVbBJXwlK",
    "userId": "guest_yRVbBJXwlK",
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJndWVzdF95UlZiQkpX..."
  }
}
```

**JWT Token Structure** (HS256):
```json
{
  "sub": "guest_<nanoId>",
  "created_at": "2026-10-19T02:45:06.441Z",
  "iat": 1792377906,
  "exp": 1792982706  // ~7 days expiry
}
```

**Verified Response** (live test):
```
HTTP 201
{"data":{"loginId":"guest_yRVbBJXwlK","orgId":"guest_yRVbBJXwlK","userId":"guest_yRVbBJXwlK","token":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."}}
```

### 3.8 Auth API Endpoints

All under `${nestApiPrefix}/auth` → `https://api.opus.pro/api/auth`

| Function | Method | Endpoint | Description |
|----------|--------|----------|-------------|
| getIdHeaders | POST | `/auth/grant-free-tool-credential` | Returns guest tokens for public tool access |
| sessionProfile | POST | `/auth/session-profile` | Returns full session/profile (requires cookies) |
| sendLoginCode | POST | `/auth/login-codes/send` | Send OTP/login code |
| getAuthorizationUrl | GET | `/auth/login-urls?...` | Generate login URLs |
| getOauthUrl | GET | `/auth/oauth-authorize?...` | OAuth authorization URL |
| authenticate | GET | `/auth/login-profiles?...` | Authenticate by email |
| getOrganizations | GET | `/auth/sso-orgs?domains=...` | SSO organization lookup |
| getConnections | GET | `/auth/sso-connections?domain=...` | SSO connection lookup |
| validateEmailForSignup | POST | `/auth/validate-email` | Email validation |
| toggleDomainWhitelists | POST | `/auth/domain-whitelists` | Domain whitelist management |
| logout | POST | `/auth/logout` | Session logout |
| completeConnectLogin | POST | `/auth/connect-completions` | Complete external auth |

---

## 4. State Management Architecture

### 4.1 Zustand/Jotai Stores (from `/tmp/opus_dashboard/1_shcqomv7f9c.js`)

#### API Store (`apiStore` - module 986231)
| Atom | Persistence Key | Default Value |
|------|-----------------|---------------|
| `apiPrefix` | `global.api.apiPrefixV2` | `https://api.opus.pro/api` |
| `nestApiPrefix` | `global.api.nestApiPrefixV2` | `https://api.opus.pro/api` |
| `planSocialApiPrefix` | `global.api.planSocialApiPrefix` | `https://api.opus.pro/api` |

#### Auth Store (`authStore` - module 847027)
| Atom | Persistence Key | Type | Description |
|------|-----------------|------|-------------|
| `user` | `global.auth.userRaw` | Persistent | Raw user object |
| `everLogin` | `global.auth.everLogin` | Persistent | Boolean |
| `currentOrgId` | `global.auth.currentOrgId` | Persistent | Current org ID |
| `currentOrgOwnerUserId` | `global.auth.currentOrgOwnerUserId` | Persistent | Org owner UID |
| `userToken` | (none) | Volatile | JWT bearer token |
| `userOrgToken` | (none) | Volatile | Org token object |
| `userOrgs` | (none) | Volatile | Array of orgs |
| `userIpAccess` | (none) | Volatile | IP access info |
| `authReady` | (computed) | Volatile | True when both tokens set |
| `userOrgInfo` | (computed) | Volatile | Decoded JWT: {userId, orgId, loginId} |
| `accountList` | (loadable) | Computed | Formatted org list |
| `currentAccount` | `global.auth.currentAccount` | Persistent | Current account |
| `cachedIdHeaders` | `global.auth.cachedIdHeaders` | Persistent | Cached ID headers |
| `envHeader` | (volatile) | Volatile | Environment header |
| `passAuthCallback` | (volatile) | Volatile | Auth callback flag |
| `isOpusEmail` | (loadable) | Computed | Check if opus.pro email |

#### Token Schedulers (module 850712)
```javascript
class TokenScheduler {
  handlerQueue = [];
  latestResult;
  hasLatestResult = false;
  
  runTask()    // Returns Promise, resolves when finishTask called
  finishTask(e) // Sets result, resolves all queued promises
  resetTask(e)  // Clears result, optionally clears queue
}

const orgTokenScheduler = new TokenScheduler();   // {current: {userId, orgId}, orgList: [...]}
const userTokenScheduler = new TokenScheduler();  // JWT token string
```

### 4.2 Clip API Header Wrapper (`useClipApiHeaderWrapperCreator` - module 693320)

Builds HTTP headers for all API requests:

| Header | Source |
|--------|--------|
| `Authorization` | `Bearer ${userTokenScheduler.runTask()}` |
| `X-OPUS-DEVICE-PLATFORM` | Hardcoded: `"web"` |
| `X-OPUS-DID` | `deviceId` atom (nanoid-based, 12 chars) |
| `X-OPUS-UTM` | `JSON.stringify(utm)` |
| `X-OPUS-ORG-ID` | `orgTokenScheduler.current.orgId` |
| `X-OPUS-USER-ID` | `orgTokenScheduler.current.userId` |
| `X-OPUS-CRID` | `nanoid(5)` (unique per request) |
| `X-OPUS-LANG` | Language cookie (`en||||||4` format) |
| `X-REAL-IP` | `debugStore.debugIp` |
| `X-Opus-Debug-Cluster-Name` | `debugStore.debugClusterName` |
| `X-OPUS-ENV` | `authStore.envHeader` |
| `X-OPUS-STEER-HINT` | `debugStore.debugApiOpusSteerHint` |
| `X-OPUS-LANE-NAME` | `debugStore.debugLane.laneName` |

**Four wrapper variants**:
- `clipApiHeaderWrapper` — full auth + org headers
- `clipApiHeaderWrapperWithData` — same, returns `.data`
- `clipApiHeaderWrapperWithoutAuth` — no Authorization header
- `clipApiHeaderWrapperWithoutOrg` — no org/user headers
- `clipApiHeaderWrapperWithUtm` — with custom UTM headers
- `clipApiHeaderWrapperSSE` — Server-Sent Events variant
- `clipApiHeaderWrapperBlob` — blob response variant

### 4.3 JWT Decoding (User Org Info)

```javascript
function userOrgInfo(e) {
  let userToken = e(c);      // get userToken atom
  let orgToken = e(d);       // get userOrgToken atom
  
  let jwtPayload = Buffer.from(userToken.split(".")[1], "base64").toString();
  let decoded = JSON.parse(jwtPayload);
  
  return {
    userId: orgToken.current.userId,
    orgId: orgToken.current.orgId,
    loginId: decoded.sub
  };
}
```

---

## 5. API Endpoints (Complete)

**Base URL**: `https://api.opus.pro/api`
**Backend Framework**: NestJS (confirmed by error format: `traceId`, `name: "NotFoundException"`)

### 5.1 Public Endpoints (No Auth Required)

| Method | Endpoint | Response |
|--------|----------|----------|
| GET | `/api/health` | `{"status":"ok"}` |
| POST | `/api/auth/grant-free-tool-credential` | `{"data":{"token":"...","userId":"guest_...","orgId":"guest_...","loginId":"guest_..."}}` |

### 5.2 Auth-Protected Endpoints (Require Bearer Token + Opus Headers)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users?q=mine` | Get current user info |
| GET | `/api/orgs` | List organizations |
| GET | `/api/org-members` | List organization members |
| GET | `/api/clip-projects` | List clip projects |
| GET | `/api/searchable-clips?q=mine` | Search clips (mine/findByQuery) |
| GET | `/api/searchable-collections` | Search collections |
| GET `/api/searchable-projects` | Search projects |
| GET | `/api/notifications` | Get notifications |
| GET | `/api/exportable-clips` | Get exportable clips |
| GET | `/api/credit-topup-skus?source=OpusClip` | Credit topup SKUs |
| GET | `/api/org-credits` | Organization credits |
| GET | `/api/subscriptions` | Subscription info |
| GET | `/api/subscription-plans` | Available plans |
| GET | `/api/social-accounts` | Connected social accounts |
| GET | `/api/campaigns/{id}` | Campaign details |
| GET | `/api/collections` | Collections list |
| GET | `/api/collections/{id}/clips` | Clips in collection |
| GET | `/api/engagement` | Engagement metrics |
| GET | `/api/clip-editor` | Clip editor data |
| GET | `/api/workflow` | Workflow configurations |
| GET | `/api/event-stream` | Server-Sent Events stream |
| POST | `/api/upload-links-v2` | Create upload link (GCS signed URL) |
| POST | `/api/upload-links-v2/{id}/complete-multipart` | Complete multipart upload |
| POST | `/api/upload-links-v2/{id}/abort-multipart` | Abort multipart upload |
| POST | `/api/clip-export-records` | Create export records |
| GET | `/api/clip-export-track` | Check export status |
| GET | `/api/check-export-operation` | Check export operation |
| POST | `/api/clip-download-records` | Download clip records |
| POST | `/api/auth/mini-app-token` | Mini-app token (for embedded tools) |
| POST | `/api/notifications` | Create notification |
| POST | `/api/publish-schedules` | Create publish schedule |
| POST | `/api/clip-cleanup-adoption` | Cleanup adoption |
| POST | `/api/clip-cleanup-ledger` | Cleanup ledger |
| POST | `/api/share-love-bonus` | Share bonus credits |
| GET | `/api/credit-topups` | Credit transactions |
| POST | `/api/credit-topups` | Add credits |
| POST | `/api/org-credits/renew-free-plan` | Renew free plan |
| POST | `/api/org-credits/add-by-trial-bonus-promotion` | Trial bonus credits |
| POST | `/api/org-credits/check-second-trial` | Check trial eligibility |
| POST | `/api/org-credits/add-by-special-link` | Add credits via link |
| POST | `/api/social-accounts/generate-oauth-url` | Get OAuth URL for social account |
| POST | `/api/social-accounts/select-sub-accounts` | Select sub-accounts |
| POST | `/api/social-copy/prompt` | Generate social copy |
| POST | `/api/social-copy` | Save social copy |
| POST | `/api/post-tasks` | Create post task |
| POST | `/api/intercom-conversions` | Intercom conversion tracking |
| POST | `/api/update-login-user-brevo-contact` | Update contact |
| GET | `/api/login-users/brevo-contacts?q=findByEmail` | Find contact by email |
| POST | `/api/check-export-operation` | Check export status |
| GET | `/api/analysis/cache?path=...` | Analysis cache |
| POST | `/api/affiliates/bind` | Bind affiliate account |
| POST | `/api/dub-clip-tasks` | Create dub clip tasks |
| POST | `/api/bad-takes/{id}/detect` | Detect bad takes |
| POST | `/api/event-tasks?postIds=...` | Create event tasks |
| GET | `/api/client-access-control?q=project` | Client access control |
| GET | `/api/domains/{domain}` | Domain configuration |
| GET | `/api/searchable-clips/{id}.{format}` | Get specific clip |
| GET | `/api/video-upscaling-tasks/proxy-download?taskId=...` | Get proxy download |
| POST | `/api/video-upscaling-tasks/rejections` | Reject upscaling |

### 5.3 API Response Patterns

**NestJS Standard Error Format**:
```json
{
  "status": 404,
  "message": "Cannot GET /api/workflows",
  "name": "NotFoundException",
  "path": "/api/workflows",
  "traceId": "673853780697123651"
}
```

**Validation Error**:
```json
{
  "errorMessage": "q must be one of the following values: findByQuery, mine",
  "errorName": "InvalidParam"
}
```

**Business Logic Error**:
```json
{
  "errorMessage": "Your plan is not allowed to use opus search.",
  "errorName": "OpusSearchNonEnterpriseUserForbiddenError"
}
```

---

## 6. Upload Pipeline

### 6.1 Architecture

The upload system uses **Google Cloud Storage (GCS)** with **resumable chunked uploads**:

1. Client requests signed URL from `/api/upload-links-v2`
2. GCS resumable session initialized via `POST` to signed URL with `x-goog-resumable: start` header
3. File uploaded in 50MB chunks (default `chunkSize = 0x3200000 = 50MB`)
4. MD5 checksum verification per chunk (comparing `X-Range-Md5` header with computed MD5)
5. Etag verification for integrity
6. Upload state checked via `GET` to session URL

### 6.2 GCS Implementation Details

**Class**: `GoogleStorageV3` (module 355374)

```javascript
class GoogleStorageV3 {
  chunkSize = 0x3200000;          // 50MB
  maxRetryForEachChunk = 1000;    // 1000 retries
  retryDelay = 500;                // 500ms
  uploadSessionUrl = "";
  uploadCanceled = false;
  
  // Methods:
  static getInstance(config)     // Singleton per config
  static getInstanceWithUploadId(uploadId)  // Per-upload singleton
  setOptions({chunkSizeMB, maxRetryEachChunk, retryDelay})
  checkBeforeUpload(signedUrl)   // Requires orgTokenScheduler
  uploadFile(file, signedUrl, options)  // Chunked upload
  uploadFileWithoutChunk(file, signedUrl, contentType)  // Single PUT
  checkUploadState()             // GET session URL for status
  resetUploadStatus()
  cancelUpload()
  resumeUpload()
}
```

**Chunk Upload Flow** (`uploadFile` method):
1. Initiates resumable session: `POST {signedUrl}` with `{"x-goog-resumable":"start"}`
2. Gets `Location` header from response → `uploadSessionUrl`
3. Splits file into 50MB chunks
4. For each chunk:
   - Computes MD5 checksum (sequential, with state caching via `getSequentialBlobChecksum`)
   - Uploads via `PUT {uploadSessionUrl}` with `Content-Range` header
   - Verifies chunk MD5 vs server-provided MD5
   - Verifies Etag MD5
   - Retries on failure (up to 1000 times, 500ms delay)
5. Checks final upload state: `GET {uploadSessionUrl}` → expects `Range` header
6. Returns `{name: "/{bucket}/{object}"}` on success

**Checksum Library**: MD5 implementation (custom, browser-compatible)

**Error Types**:
- `FileChunkNotMatch` — Chunk MD5 doesn't match
- `UploadFailureExceedRetryTime` — Max retries exceeded
- `AuthorizationFailure` — Missing org tokens
- `DuplicateCall` — Concurrent upload attempt
- `ParameterMissingError` — Missing signed URL
- `UploadIncompleteError` — Upload didn't complete
- `ResumableSessionInitError` — Failed to start session

### 6.3 Upload Link API

```javascript
// Request: POST /api/upload-links-v2
// Response contains signed URL:
{
  "data": {
    "url": "https://storage.googleapis.com/...",  // GCS signed URL
    "id": "...",  // Upload ID
    // ... other fields
  }
}
```

### 6.4 Upload Link Hook (`useUploadApi` - module 551409)

```javascript
const useUploadApi = () => {
  const nestApiPrefix = useAtomValue(apiStore.nestApiPrefix);
  const { clipApiHeaderWrapper } = useClipApiHeaderWrapperCreator();
  const base = `${nestApiPrefix}/upload-links-v2`;
  
  return {
    createUploadLink: async (payload, options) => 
      await clipApiHeaderWrapper(base, {method:"POST", body:JSON.stringify(payload)}, options),
    
    completeMultipartUpload: async (uploadId, gcsUploadId, parts) => 
      await clipApiHeaderWrapper(`${base}/${uploadId}/complete-multipart`, 
        {method:"POST", body:JSON.stringify({gcsUploadId, parts})}),
    
    abortMultipartUpload: async (uploadId, gcsUploadId) => 
      await clipApiHeaderWrapper(`${base}/${uploadId}/abort-multipart`, 
        {method:"POST", body:JSON.stringify({gcsUploadId})})
  }
}
```

### 6.5 Retry Library

**Library**: `async-retry` (embedded)
- Options: `{retries: 100, maxTimeout: 10000}`
- Used by `withHighToleranceRetry` decorator

---

## 7. Subscription & Credits System

### 7.1 Plan Types

| Internal Enum | Display Name |
|---------------|-------------|
| `ESSENTIAL` | Essential |
| `FREE` / `PERSONAL` | FreePlan |
| `PRO` | Pro |
| `MAX` | Max |
| `STARTER` | Starter |
| `TRIAL` | FreeTrial |
| `ENTERPRISE` | Enterprise |

### 7.2 Billing Platforms

- **Stripe** (primary payment provider)
- **RevenueCat** (mobile subscription platform)
- **Dlocal** (emerging markets payments, PIX)
- **Payment Platform Enum**: `STRIPE`, `REVENUE_CAT`, `REVENUE_CAT_ANDROID`, `DL_PIX_AUTO`

### 7.3 Credit System

| Resource | Cost |
|----------|------|
| Video Upscaling (HD) | 70 credits/minute |
| Max upscale duration | 300 seconds (default) |
| Free trial credits | Via trial bonus promotion |

### 7.4 Subscription API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/subscriptions` | Get user subscriptions |
| POST | `/api/subscriptions/cancel` | Cancel subscription |
| POST | `/api/subscriptions/withdraw-cancel` | Undo cancellation |
| POST | `/api/subscriptions/confirm-payment` | Confirm payment |
| POST | `/api/subscriptions/currency-code-operation` | Currency operations |
| POST | `/api/subscriptions/estimate-amount` | Estimate price |
| POST | `/api/subscriptions/payment-method-currency-operation` | Payment method currency |
| POST | `/api/org-credits/renew-free-plan` | Renew free plan |
| POST | `/api/org-credits/add-by-trial-bonus-promotion` | Add trial bonus |
| POST | `/api/org-credits/check-second-trial` | Check trial eligibility |
| POST | `/api/org-credits/add-by-special-link` | Add credits via special link |

---

## 8. Feature Flags (Statsig)

Feature flags are managed via **Statsig** (statsig.com):

| Flag | Description |
|------|-------------|
| `enable_workflow_revamp` | New workflow UI |
| `brand_template_ux` | Brand template UX improvements |
| `enable_export_4k` | 4K export capability |
| `enable_auto_hook` | Automatic hook generation |
| `broll_credits` | B-roll credit system |
| `editor_quick_operation` | Quick editor operations |
| `scheduler_thumbnail` | Scheduler thumbnail generation |
| `workflow_revamp` | Full workflow revamp |
| `oc_upscale_ui_experiment` | Upscale UI experiment |
| `oc_upscale_ux` | Upscale UX experiment |
| `block-disposable-signup` | Block disposable email signups |
| `orgs_with_member_names` | Show member names in orgs |
| `orgs_with_enterprise_search` | Enterprise search gating |
| `oc_credit_topup_enabled` | Credit topup feature toggle |
| `web_prod_lanes_via_lanes_api` | Lane API routing toggle |
| `enable_workflow_revamp` | Workflow v2 rollout |

**Statsig Configuration**:
- SDK: `statsig.com` (SPA variant)
- Network fallback key: `3490466545`
- Stable ID key: `statsig.stable_id.1192857184`
- Session ID key: `statsig.session_id.1192857184`

---

## 9. Routes

| Route | Authentication | Description |
|-------|---------------|-------------|
| `/` | Redirect | → `/dashboard` |
| `/dashboard` | Required | Main dashboard |
| `/auth/oauth/login` | Public | Auth0 login page |
| `/auth/callback` | Required | Auth0 callback |
| `/auth/orgs` | Required | Organization selection |
| `/auth/redirect` | Required | Redirect handler |
| `/workflow` | Required | Workflow editor |
| `/search` | Public | Search clips |
| `/search/results` | Public | Search results |
| `/clip-editor` | Required | Clip editor |
| `/submit-video` | Required | Upload submit |
| `/captions` | Public | AI captions tool (public access) |
| `/subscription` | Required | Subscription management |
| `/tools/*` | Mixed | AI tools (some public) |
| `/tools/ai-show-note-generator` | Public | AI show notes |
| `/tools/ai-video-summarizer` | Public | AI video summarizer |
| `/tools/tiktok-bio-generator` | Public | TikTok bio generator |
| `/tools/tiktok-caption-generator` | Public | TikTok caption generator |
| `/tools/tiktok-hashtag-generator` | Public | TikTok hashtag generator |
| `/tools/tiktok-username-generator` | Public | TikTok username generator |
| `/tools/youtube-title-generator` | Public | YouTube title generator |
| `/tools/youtube-description-generator` | Public | YouTube description generator |
| `/tools/youtube-hashtag-generator` | Public | YouTube hashtag generator |
| `/tools/youtube-thumbnail-maker` | Public | YouTube thumbnail maker |
| `/tools/youtube-channel-name` | Public | YouTube channel name generator |
| `/tools/video-compressor` | Public | Video compressor |
| `/tools/video-converter` | Public | Video converter |
| `/tools/transcript-maker` | Public | Transcript maker |
| `/tools/photo-relighting` | Public | Photo relighting |
| `/tools/video-script-generator` | Public | Video script generator |
| `/tools/mkv-to-mp4` | Public | MKV to MP4 |
| `/tools/mov-to-mp4` | Public | MOV to MP4 |
| `/tools/avi-to-mp4` | Public | AVI to MP4 |
| `/tools/mp4-to-mov` | Public | MP4 to MOV |
| `/tools/mp4-to-webm` | Public | MP4 to WebM |
| `/tools/webm-to-mp4` | Public | WebM to MP4 |
| `/lp-embed` | Public | Landing page embed |
| `/lp-linkedin-badge` | Public | LinkedIn badge |
| `/lp-auto-close` | Public | Auto-close landing page |
| `/welcome-back` | Public | Welcome back page |

---

## 10. External Services & Integrations

### 10.1 Analytics & Monitoring

| Service | Purpose | Key Info |
|---------|---------|----------|
| **Datadog RUM** | Real-user monitoring, session replay | Cookie: `_dd_s`; Endpoint: `/rum/replay/sessions` |
| **Sentry** | Error tracking | Client SDK embedded |
| **Mixpanel** | Product analytics | Cookie: `mp_..._mixpanel`; Distinct ID: `guest_xgbIW73W3Odt`; Device ID present |
| **Microsoft Clarity** | Heatmaps & session recordings | `clarity.js` |
| **Cloudflare** | CDN, DDoS protection, Turnstile | `cf_clearance` cookie; `0x4AAAAAAEXb6Wm1YMBksOrz` Turnstile key |
| **Google Analytics 4** | Web analytics | `gtag`/`G` config |
| **Cookiebot** | Cookie consent management | GDPR compliance |

### 10.2 Auth & Identity

| Service | Purpose | Key Info |
|---------|---------|----------|
| **Auth0** | Primary auth provider | Domain: `auth.opus.pro`; API: `opuspro.us.auth0.com`; Client ID: `ykTnDeep3yBiWEr5ugt04fpYDIoiOtrY` |
| **WorkOS** | SSO/social login | Used for enterprise SSO |
| **Cloudflare Turnstile** | Anti-bot protection | Site key: `0x4AAAAAAEXb6Wm1YMBksOrz`; Action: `otp-login` |

### 10.3 Business Tooling

| Service | Purpose | Key Info |
|---------|---------|----------|
| **Intercom** | Customer support/messaging | `window.Intercom`, `intercomSettings`, `intercom-conversions` API |
| **ProfitWell** | Subscription analytics | `profitwell.js` |
| **Brevo (Sendinblue)** | Email marketing | `update-login-user-brevo-contact`, `brevo-contacts` endpoint |
| **Retool** | Internal admin tools | Workflow: `retool_wk_7e531f88967b459da92afd4539551173` |
| **Canny** | Feature requests/voting | `feature-requests` endpoint |
| **Dub** | Link management | `dub-clip-tasks` endpoint |

### 10.4 Infrastructure

| Service | Purpose | Key Info |
|---------|---------|----------|
| **Google Cloud Storage** | Video/file storage | `storage.googleapis.com/wip.gcs.opus.pro/...`; Resumable upload via `GoogleStorageV3` |
| **Stripe** | Payment processing | `PaymentPlatform.STRIPE`, `STRIPE` currency codes |
| **Dlocal** | Emerging markets payments | `DL_PIX_AUTO` platform, PIX payments |
| **RevenueCat** | Mobile subscriptions | `REVENUE_CAT` platform |
| **Google Analytics 4** | Measurement | Via `gtag` |
| **Google reCAPTCHA v2** | Legacy captcha | `google.com/recaptcha`

### 10.5 Engine/Microservices

| Service | Purpose | Key Info |
|---------|---------|----------|
| **Workflow Engine** | Video processing workflows | `https://{env}.eng.opus.pro/namespaces/opus/workflows?query=...` |
| **Engine Manager** | Video processing orchestration | `clip-engine-manager` in debug tab map |
| **Lanes API** | A/B testing lane routing | `https://lanes-api.eng.opus.pro/api` |
| **Agent Service** | AI agent backend | `https://agent.opus.pro/` |
| **AI Producer** | AI content production | `https://producer.opus.pro/` |
| **Solo Mode** | Debug/preview solo runs | `https://agent.opus.pro/solo` |

---

## 11. Key Technical Components

### 11.1 AI Workflows

Workflow types supported:
- `quick_normal` — Long to shorts
- `quick_editor` — Video editor
- `caption` — AI captions
- `broll` — AI B-roll
- `sound_effect` — AI sound effect
- `reframe` — AI reframe
- `voiceover` — Voiceover hook
- `upscale` — Video upscaling
- `video_dubbing` — Video dubbing
- `enhance_speech` — Enhance speech

**AI Producer Pills**: `ai_producer` (max 3 shown before)

### 11.2 Card Engine

Full card composition engine with:
- Animation effects: `card-engine/animation-effects`
- Animation presets: `card-engine/animation-presets`
- Effect filters: `card-engine/effect-filters`
- Scene management: `card-engine/scene`, `card-engine/scene-easing`, `card-engine/scene-effects`, `card-engine/scene-text`
- Text tools: `card-engine/motion`, `card-engine/catalog`, `card-engine/project`

### 11.3 Editor Features

- `editor-history-records` — Editor history with file name queries
- `editor/ai-video-broll-nps-cta` — AI B-roll NPS feedback
- Quick operation mode: `editor_quick_operation`
- Brand templates: `brand_template_ux`, `brand-kit-definitions`, `brand-kits`, `brand-templates`

### 11.4 Social Features

| Endpoint | Description |
|----------|-------------|
| `/api/social-accounts/generate-oauth-url` | Generate OAuth URL for social platform |
| `/api/social-accounts/select-sub-accounts` | Select social sub-accounts |
| `/api/social-copy/prompt` | AI-generated social copy suggestions |
| `/api/social-copy` | Save social copy |
| `/api/post-tasks` | Create scheduling/publishing tasks |
| `/api/publish-schedules` | Publish scheduling |

### 11.5 Video Processing

| Feature | Details |
|---------|---------|
| Video upscaling | 70 credits/minute (HD); max 300s default |
| B-roll generation | `broll-free-quota`, `broll/check-quota`, `broll-generations` |
| Auto-post | `auto-post/calendar` |
| Eye contact correction | `/eye-contact` endpoint |
| Voice enhancement | `/voice-enhancement` |
| Match cut | Pre-configured templates (`match-cut/native-paper-*`) |
| Golden series hooks | 50+ predefined hook templates |

---

## 12. Cookies & Storage

### 12.1 Browser Cookies (extracted via CDP)

| Cookie | Value | Purpose |
|--------|-------|---------|
| `lang` | `en\|\|\|\|\|\|4` | Language setting |
| `cf_clearance` | (Cloudflare token) | Cloudflare bot bypass |
| `mp_..._mixpanel` | JSON with `distinct_id`, `device_id`, `user_id=guest_xgbIW73W3Odt` | Mixpanel analytics |
| `_dd_s` | (Datadog session ID) | Datadog RUM session tracking |
| `opus_current_org` | (Org ID) | Current organization selection |

### 12.2 LocalStorage Keys (extracted from `/captions` page)

| Key | Value |
|-----|-------|
| `statsig.network_fallback.3490466545` | Statsig network fallback |
| `__mpq_c6867cb9d3aa0892931dab875068281c_ev` | Mixpanel event queue |
| `statsig.stable_id.1192857184` | Statsig stable ID |
| `statsig.session_id.1192857184` | Statsig session ID |

### 12.3 Persistent Storage Keys (Zustand/Jotai Persistence)

| Key | Type | Purpose |
|-----|------|---------|
| `global.api.apiPrefixV2` | String | API base URL (default: `https://api.opus.pro/api`) |
| `global.api.nestApiPrefixV2` | String | Nest API base URL (default: `https://api.opus.pro/api`) |
| `global.api.planSocialApiPrefix` | String | Plan/Social API prefix |
| `global.auth.userRaw` | Object | Raw user data |
| `global.auth.everLogin` | Boolean | Has user ever logged in |
| `global.auth.currentOrgId` | String | Current org ID |
| `global.auth.currentOrgOwnerUserId` | String | Org owner user ID |
| `global.auth.currentAccount` | Object | Current account |
| `global.auth.cachedIdHeaders` | Object | Cached guest token ({token, userId, orgId, loginId}) |
| `global.baseContext.deviceIdRaw` | String | Device ID (nanoid, 12 chars) |
| `global.baseContext.utm` | Object | UTM parameters |
| `clip.debug.debugMode` | Boolean | Debug mode toggle |
| `clip.debug.debugIp` | String | Debug IP override |
| `clip.debug.debugClusterName` | String | Debug cluster name |
| `clip.debug.debugApiOpusEnv` | String | Debug API environment |
| `clip.debug.debugApiOpusSteerHint` | Object | API steering hint |
| `clip.debug.debugApiEndpointEnvMap` | Object | API endpoint environment map |
| `clip.debug.debugSoloName` | String | Solo debug name |
| `clip.debug.debugRuntimeEnv` | String | Runtime environment |
| `clip.debug.debugQuickstartVariant` | String (default: "auto") | Quickstart A/B variant |
| `clip.debug.debugQuickstartOrderLabels2` | Array | Quickstart order labels |
| `clip.debug.debugQuickstartScriptToVideo2` | String (default: "auto") | Script-to-video config |
| `subscription.subscriptionPollTimeout` | Boolean | Subscription polling flag |

---

## 13. Network Traffic Analysis

### 13.1 Login Flow (clip.opus.pro → /auth/oauth/login)

**849 network events** captured during redirect chain:
1. Initial request to `https://clip.opus.pro` → 302 redirect to `/dashboard`
2. `/dashboard` → 302 redirect to `/auth/oauth/login?state=...`
3. Auth0 OAuth flow begins: `https://auth.opus.pro/authorize?...`
4. Cloudflare Turnstile challenge may appear (OTP flow with site key `0x4AAAAAAEXb6Wm1YMBksOrz`)
5. Auth0 token exchange via `https://opuspro.us.auth0.com/oauth/token`
6. Redirect back to `https://clip.opus.pro/auth/callback`
7. Internal token exchange: `POST /api/auth/grant-free-tool-credential`

### 13.2 Public Captions Page

**Page**: `https://clip.opus.pro/captions`
**Status**: Publicly accessible without authentication
**Storage Keys Found**: Statsig keys, Mixpanel event queue
**CTA**: "Sign up for OpusClip" button visible (no auth required)

### 13.3 Search Page

**Page**: `https://clip.opus.pro/search`
**Status**: Publicly accessible without authentication

---

## 14. Backend Fingerprints

### 14.1 API Server

- **Framework**: NestJS
- **Error Format**: Standard NestJS exceptions with `statusCode`, `message`, `error`, `name`, `path`, `traceId`
- **Trace ID**: Present in all error responses (correlation ID for request tracing)

### 14.2 Frontend Build

- **Framework**: Next.js 15.x (Turbopack)
- **Bundler**: Turbopack (evidenced by `__turbopack_load_page_chunks` in bundles)
- **Build ID**: Production mode (no source maps exposed)
- **JS Runtime**: Modern ES (uses `crypto.subtle`, `MessageChannel`, `AbortController`)

### 14.3 Infrastructure

- **CDN**: Cloudflare (evidenced by `cf_clearance` cookie)
- **Edge**: Cloudflare Workers likely for edge logic
- **Storage**: Google Cloud Storage (GCS) with signed URLs
- **Hosting**: Likely Next.js Node.js server with SSR

---

## 15. Data Flow Architecture

```
User Browser
    │
    ├── Auth0 SPA SDK (auth0-spa-js)
    │   ├── Login via https://auth.opus.pro
    │   ├── OAuth flow → opuspro.us.auth0.com/oauth/token
    │   ├── Token exchange (grant_type: token-exchange)
    │   └── JWT stored in localStorage
    │
    ├── Clip Frontend (Next.js 15 + Turbopack)
    │   ├── Auth0Provider wraps app with config
    │   ├── AuthContext for custom auth state
    │   ├── Zustand/Jotai stores for state management
    │   ├── Token Schedulers cache user/org tokens
    │   └── All API calls flow through clipApiHeaderWrapper
    │
    └── API Calls → https://api.opus.pro/api/*
        ├── Headers: Authorization, X-OPUS-*, X-REAL-IP
        ├── NestJS backend processes requests
        ├── GCS for file storage (upload-links-v2 → signed URLs)
        └── Responses: JSON, SSE streams, or binary blobs

Upload Flow:
    1. POST /api/upload-links-v2 → GCS signed URL
    2. POST {signedUrl} (x-goog-resumable: start) → Upload session URL
    3. PUT {sessionUrl} (chunks with Content-Range + MD5)
    4. PUT {sessionUrl} (Content-Range: bytes */) → Check completion
    5. POST /api/upload-links-v2/{id}/complete-multipart
```

---

## 16. Debug & Development

### 16.1 Debug Store Configuration

The app includes a comprehensive debug portal (`debugStore`):

| Debug Key | Default | Description |
|-----------|---------|-------------|
| `debugMode` | false | Enable debug mode |
| `debugDashboardUiMode` | "real" | Dashboard UI mode |
| `debugTabMap` | (see 4.1) | Maps debug tabs to API origins |
| `debugIp` | "" | Override real IP |
| `debugClusterName` | "" | Cluster name override |
| `debugApiOpusEnv` | "" | API Opus environment |
| `debugApiOpusSteerHint` | {} | API steering hint |
| `debugApiEndpointEnvMap` | {} | Endpoint environment overrides |
| `debugSoloName` | "" | Solo mode name |
| `debugAutoSyncWithSolo` | "false" | Auto-sync with solo mode |
| `debugRuntimeEnv` | "" | Runtime environment override |

**Debug Tabs**: ARC_CHAT, AUTH, BRAND_TEMPLATE, BRAND_KIT, CAMPAIGN_LANDING, CLIP, CLIP_EDIT, DASHBOARD, WORKFLOW, FREE_TOOL, FREE_TOOL_PROJECT, JOIN_TEAM, SUBSCRIPTION, SEARCH, LOGIN, CALENDAR, FSC, OMNI

### 16.2 Lane Preview

- Production origins: `https://clip.opus.pro`, `https://lane-preview.eng.opus.pro`
- Staging origins: `https://stg-clip.opus.pro`, `https://stg-lane-preview.eng.opus.pro`

---

## 17. API Verification Results

### 17.1 Public Endpoints

| Endpoint | Method | Status | Response |
|----------|--------|--------|----------|
| `/api/health` | GET | 200 | `{"status":"ok"}` |
| `/api/auth/grant-free-tool-credential` | POST | 201 | `{"data":{"loginId":"guest_...","orgId":"guest_...","userId":"guest_...","token":"..."}` |

### 17.2 Auth-Protected Endpoints (With Guest Token)

| Endpoint | Method | Status | Response |
|----------|--------|--------|----------|
| `/api/users` | GET | 401 | Unauthorized |
| `/api/orgs` | GET | 401 | Unauthorized |
| `/api/clip-projects` | GET | 401 | Unauthorized |
| `/api/searchable-clips?q=mine` | GET | 403 | `"errorName":"OpusSearchNonEnterpriseUserForbiddenError"` |
| `/api/upload-links-v2` | POST | 401 | Unauthorized |
| `/api/auth/mini-app-token` | POST | 401 | Unauthorized |
| `/api/notifications` | POST | 401 | Unauthorized |
| `/api/clip-export-records` | POST | 401 | Unauthorized |
| `/api/me` | GET | 404 | NotFoundException |
| `/api/subscription` | GET | 404 | NotFoundException |
| `/api/workflows` | GET | 404 | NotFoundException |
| `/api/subscription-plans` | GET | 401 | Unauthorized |
| `/api/subscriptions` | GET | 401 | Unauthorized |
| `/api/exportable-clips` | GET | 401 | Unauthorized |
| `/api/searchable-projects?q=mine` | GET | 401 | Unauthorized |

### 17.3 Error Response Format (NestJS)

```json
{
  "status": 404,
  "message": "Cannot GET /api/workflows",
  "name": "NotFoundException",
  "path": "/api/workflows",
  "traceId": "673853780697123651"
}
```

---

## 18. Summary of Key Findings

1. **Guest Token Endpoint**: `POST /api/auth/grant-free-tool-credential` returns guest JWT tokens without any authentication. These tokens are valid for ~7 days and contain `userId`, `orgId`, `loginId`, and a JWT bearer token.

2. **Auth0 Configuration**: Fully extracted - domain `auth.opus.pro`, client ID `ykTnDeep3yBiWEr5ugt04fpYDIoiOtrY`, audience `https://opuspro.us.auth0.com/api/v2/`, scope `openid profile email`, cache in localStorage.

3. **Cloudflare Turnstile**: Site key `0x4AAAAAAEXb6Wm1YMBksOrz` with action `otp-login` blocks automated bot access.

4. **API Base URL**: `https://api.opus.pro/api` (confirmed from both `apiStore.nestApiPrefix` default and live tests).

5. **Backend**: NestJS with standard error format (status, message, name, path, traceId).

6. **Upload Pipeline**: Google Cloud Storage with 50MB chunked uploads, MD5 checksum verification, retry logic (1000 retries).

7. **State Management**: Zustand + Jotai with persistence; token schedulers use Promise-based queuing for token caching.

8. **Public Routes**: `/captions`, `/search`, `/auth/oauth/login` are accessible without authentication; all other routes require Auth0 authentication.

9. **Feature Flags**: Statsig-managed with gates like `web_prod_lanes_via_lanes_api`, `orgs_with_enterprise_search`, etc.

10. **Multi-tenant Architecture**: Support for organization switching with domain-scoped cookies (`.opus.pro`).
