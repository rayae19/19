# Soundbound — Deployment Guide

## Project structure

```
soundbound/
├── soundbound.jsx       ← main app component (all pages + services)
├── server.js            ← Express CORS proxy (deployed on Render)
├── vite.config.js       ← Vite config with dev proxy + env vars
├── vercel.json          ← Vercel routing (SPA + /api rewrite to Render)
├── package.json
├── index.html
└── src/
    └── main.jsx         ← React 18 root, mounts App from soundbound.jsx
```

---

## Local development

```bash
npm install

# Terminal 1 — Express proxy backend
node server.js          # listens on :3001

# Terminal 2 — Vite dev server
npm run dev             # listens on :5173, proxies /api → :3001
```

Open http://localhost:5173

---

## Deploy to Render (backend)

1. Push repo to GitHub / GitLab.
2. In Render → New Web Service → connect repo.
3. Settings:
   - **Build command**: `npm install`
   - **Start command**: `node server.js`
   - **Node version**: 18+
4. Add environment variables if needed:
   - `ALLOWED_ORIGINS` = `https://your-app.vercel.app` (comma-separated)
5. Deploy. Copy the service URL, e.g. `https://soundbound-proxy.onrender.com`.

---

## Deploy to Vercel (frontend)

1. In Vercel → New Project → import repo.
2. Framework preset: **Vite**
3. Add environment variable:
   - `VITE_API_URL` = `https://soundbound-proxy.onrender.com`  ← your Render URL
4. Update `vercel.json` — replace `YOUR_RENDER_APP` with your actual Render subdomain:
   ```json
   "destination": "https://soundbound-proxy.onrender.com/api/:path*"
   ```
5. Deploy.

---

## How the proxy chain works in production

```
Browser
  │
  ├─① Direct fetch to target URL
  │     → succeeds if target sends CORS headers (rare for GitLab raw)
  │
  ├─② /api/repo-proxy?url=<encoded>
  │     → Vite dev: forwarded to localhost:3001
  │     → Vercel prod: rewritten to Render backend
  │     → Render: makes real server-side fetch, returns JSON
  │
  ├─③ api.allorigins.win (public fallback)
  │
  └─④ corsproxy.io (second public fallback)
```

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `VITE_API_URL` | Vercel build env | Render backend base URL (no trailing slash) |
| `PORT` | Render | Port Express listens on (Render sets this automatically) |
| `ALLOWED_ORIGINS` | Render | Comma-separated allowed CORS origins |
