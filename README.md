# Vocab Backend - Deploy Guide

## What this is
A Node.js + SQLite backend for the CET-4/6 spaced-repetition vocab app.

## Files
- server.js   — Express API
- db.js       — SQLite + SM-2 algorithm
- schema.sql  — DB schema
- words.json  — 2600 CET-4 + 5500 CET-6 vocabularies (real, sourced from ECDICT)
- package.json
- Dockerfile / render.yaml / fly.toml / cyclic.json / Procfile — one-click deploy configs

## Endpoints (all under /api)
- POST /api/register       → { key: "kid-xxxx-xxxx" }
- GET  /api/me
- POST /api/init           body: { tier, mode: 15|30|60 }
- GET  /api/words/today
- GET  /api/due
- POST /api/grade          body: { word, tier, grade: again|hard|good|easy|known }
- GET  /api/stats
- POST /api/reset
- GET  /healthz

## Deploy in 60 seconds

### Render (easiest, recommended)
1. Push this folder to a new GitHub repo (can be private).
2. Go to https://render.com → New → Blueprint → connect the repo.
3. Render reads render.yaml, builds with `npm install`, runs `npm start`,
   gives you a free HTTPS URL like https://vocab-backend-xyz.onrender.com.
4. SQLite data persists on the mounted disk (`/data`).

### Fly.io (also free, more powerful)
1. `fly launch --no-deploy --copy-config`
2. `fly volumes create vocab_data --size 1`
3. `fly deploy`
4. Get URL `https://vocab-backend-x9f2.fly.dev`.

### Cyclic.sh (free, no credit card)
1. Sign in with GitHub at https://cyclic.sh.
2. `Connect a project` → pick repo → done.

### Anywhere with Docker
`docker run -p 8080:8080 -v $(pwd)/data:/data your-image`
