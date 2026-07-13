// server.js — Express API for vocab backend
import express from "express";
import { randomBytes } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  tierSize, getOrCreateUser, getUser,
  initProgress, dueItems, todayItems,
  gradeWord, stats, deleteProgressForUser,
} from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "32kb" }));
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

const PORT = parseInt(process.env.PORT || "3000", 10);

app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    if (req.path === "/healthz") return;
    console.log(`${req.method} ${req.path} -> ${res.statusCode} ${Date.now()-t0}ms`);
  });
  next();
});

function authKey(req) {
  const h = req.get("Authorization") || "";
  const m = h.match(/^Bearer (.+)$/i);
  return m ? m[1] : (req.query.key || (req.body && req.body.key) || null);
}
function newKey() {
  const r = randomBytes(4).toString("hex");
  return "kid-" + r.slice(0,4) + "-" + r.slice(4,8);
}
function requireUser(req, res) {
  const k = authKey(req);
  if (!k) { res.status(401).json({ ok:false, error:"missing key" }); return null; }
  const u = getUser(k);
  if (!u) { res.status(401).json({ ok:false, error:"unknown key" }); return null; }
  return { user: u, key: k };
}

app.get("/healthz", (req, res) => {
  res.json({ ok: true, words: { cet4: tierSize("cet4"), cet6: tierSize("cet6") } });
});

app.post("/api/register", (req, res) => {
  const k = newKey();
  getOrCreateUser(k);
  res.json({ ok:true, key: k });
});
app.get("/api/register", (req, res) => {
  const k = newKey();
  getOrCreateUser(k);
  res.json({ ok:true, key: k });
});

app.get("/api/me", (req, res) => {
  const c = requireUser(req, res); if (!c) return;
  const u = c.user;
  const s = u.tier ? stats(u.uid, u.tier) : { total:0, known_count:0, learning_count:0, due_today:0, streak_days:0 };
  res.json({ ok:true, key:c.key, tier:u.tier||null, mode:u.mode||null, total:s.total, learned:s.known_count, due_today:s.due_today, streak_days:s.streak_days });
});

app.post("/api/init", (req, res) => {
  const c = requireUser(req, res); if (!c) return;
  const tier = String(req.body.tier || "");
  const mode = parseInt(req.body.mode, 10);
  if (!["cet4","cet6"].includes(tier)) return res.status(400).json({ ok:false, error:"tier must be cet4 or cet6" });
  if (![15,30,60].includes(mode))      return res.status(400).json({ ok:false, error:"mode must be 15/30/60" });
  try {
    const r = initProgress(c.key, tier, mode);
    res.json({ ok:true, total:r.total, daily_target:r.daily_target, already:r.already });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.get("/api/due", (req, res) => {
  const c = requireUser(req, res); if (!c) return;
  const tier = String(req.query.tier || c.user.tier || "");
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  if (!["cet4","cet6"].includes(tier)) return res.status(400).json({ ok:false, error:"bad tier" });
  const items = dueItems(c.key, tier, limit);
  res.json({ ok:true, items, count: items.length });
});

app.get("/api/words/today", (req, res) => {
  const c = requireUser(req, res); if (!c) return;
  const tier = String(req.query.tier || c.user.tier || "");
  if (!["cet4","cet6"].includes(tier)) return res.status(400).json({ ok:false, error:"bad tier" });
  const items = todayItems(c.key, tier);
  const today0 = (() => { const d=new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
  const completed = items.filter(i => i.last_reviewed && i.last_reviewed >= today0).length;
  res.json({ ok:true, day_index:0, total_today:items.length, completed_today:completed, items });
});

app.post("/api/grade", (req, res) => {
  const c = requireUser(req, res); if (!c) return;
  const { word, tier, grade } = req.body || {};
  if (!word || !["cet4","cet6"].includes(tier)) return res.status(400).json({ ok:false, error:"missing word/tier" });
  try {
    const r = gradeWord(c.key, word, tier, grade);
    res.json(r);
  } catch (e) {
    res.status(400).json({ ok:false, error: e.message });
  }
});

app.get("/api/stats", (req, res) => {
  const c = requireUser(req, res); if (!c) return;
  const tier = String(req.query.tier || c.user.tier || "");
  if (!["cet4","cet6"].includes(tier)) return res.status(400).json({ ok:false, error:"bad tier" });
  res.json(stats(c.key, tier));
});

app.post("/api/reset", (req, res) => {
  const c = requireUser(req, res); if (!c) return;
  const n = deleteProgressForUser(c.key);
  res.json({ ok:true, deleted:n });
});

// Serve frontend if present
const FRONTEND_DIR = process.env.FRONTEND_DIR || path.join(__dirname, "..", "frontend");
if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
  app.get(/^(?!\/api\/|\/healthz).+/, (req, res, next) => {
    const idx = path.join(FRONTEND_DIR, "index.html");
    if (fs.existsSync(idx)) return res.sendFile(idx);
    next();
  });
  console.log("serving frontend from", FRONTEND_DIR);
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`vocab backend listening on :${PORT}`);
  console.log(`words: CET-4=${tierSize("cet4")} CET-6=${tierSize("cet6")}`);
   console.log(`persistence: ${process.env.GH_TOKEN ? 'GitHub repo: ' + (process.env.GH_REPO||'SctrlB/vocab-backend') : 'EPHEMERAL (no GH_TOKEN)'}`);
});
