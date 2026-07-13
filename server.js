// server.js — pure node HTTP server, no express dep
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import {
  tierSize, getOrCreateUser, getUser,
  initProgress, dueItems, todayItems,
  gradeWord, stats, deleteProgressForUser,
} from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3000", 10);

// Body collection utility
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch(e) { resolve({}); } });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}
function send(res, status, text = "") {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end(text);
}

function authKey(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer (.+)$/i);
  return m ? m[1] : null;
}
function newKey() {
  const r = randomBytes(4).toString("hex");
  return "kid-" + r.slice(0,4) + "-" + r.slice(4,8);
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  res.on("finish", () => {
    if (req.url !== "/healthz") console.log(`${req.method} ${req.url} -> ${res.statusCode} ${Date.now()-t0}ms`);
  });
  if (req.method === "OPTIONS") return send(res, 204);

  // Healthz
  if (req.method === "GET" && req.url === "/healthz") {
    return sendJson(res, 200, { ok: true, words: { cet4: tierSize("cet4"), cet6: tierSize("cet6") } });
  }

  // Identify user (from Bearer)
  const key = authKey(req);
  const user = key ? getUser(key) : null;

  // Helper: 401 if needed
  function require() {
    if (!key || !user) { sendJson(res, 401, { ok: false, error: "missing or unknown key" }); return false; }
    return true;
  }

  // Routing
  try {
    // POST /api/register
    if (req.method === "POST" && req.url === "/api/register") {
      const k = newKey(); getOrCreateUser(k);
      return sendJson(res, 200, { ok: true, key: k });
    }
    // GET /api/me
    if (req.method === "GET" && req.url.startsWith("/api/me")) {
      if (!require()) return;
      const s = user.tier ? stats(user.key, user.tier) : { total:0, known_count:0, learning_count:0, due_today:0, streak_days:0 };
      return sendJson(res, 200, { ok:true, key:user.key, tier:user.tier||null, mode:user.mode||null, total:s.total, learned:s.known_count, due_today:s.due_today, streak_days:s.streak_days });
    }
    // POST /api/init
    if (req.method === "POST" && req.url === "/api/init") {
      if (!require()) return;
      const body = await readBody(req);
      const tier = String(body.tier || "");
      const mode = parseInt(body.mode, 10);
      if (!["cet4","cet6"].includes(tier)) return sendJson(res, 400, { ok:false, error:"tier must be cet4 or cet6" });
      if (![15,30,60].includes(mode))      return sendJson(res, 400, { ok:false, error:"mode must be 15/30/60" });
      try {
        const r = initProgress(user.key, tier, mode);
        return sendJson(res, 200, { ok:true, total:r.total, daily_target:r.daily_target, already:r.already });
      } catch (e) { return sendJson(res, 500, { ok:false, error:e.message }); }
    }
    // GET /api/due
    if (req.method === "GET" && req.url.startsWith("/api/due")) {
      if (!require()) return;
      const url = new URL(req.url, "http://x");
      const tier = String(url.searchParams.get("tier") || user.tier || "");
      const limit = Math.min(parseInt(url.searchParams.get("limit"), 10) || 50, 100);
      if (!["cet4","cet6"].includes(tier)) return sendJson(res, 400, { ok:false, error:"bad tier" });
      const items = dueItems(user.key, tier, limit);
      return sendJson(res, 200, { ok:true, items, count: items.length });
    }
    // GET /api/words/today
    if (req.method === "GET" && req.url.startsWith("/api/words/today")) {
      if (!require()) return;
      const url = new URL(req.url, "http://x");
      const tier = String(url.searchParams.get("tier") || user.tier || "");
      if (!["cet4","cet6"].includes(tier)) return sendJson(res, 400, { ok:false, error:"bad tier" });
      const items = todayItems(user.key, tier);
      const today0 = (() => { const d=new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
      const completed = items.filter(i => i.last_reviewed && i.last_reviewed >= today0).length;
      return sendJson(res, 200, { ok:true, day_index:0, total_today:items.length, completed_today:completed, items });
    }
    // POST /api/grade
    if (req.method === "POST" && req.url === "/api/grade") {
      if (!require()) return;
      const body = await readBody(req);
      const { word, tier, grade } = body || {};
      if (!word || !["cet4","cet6"].includes(tier)) return sendJson(res, 400, { ok:false, error:"missing word/tier" });
      try {
        const r = gradeWord(user.key, word, tier, grade);
        return sendJson(res, 200, r);
      } catch (e) { return sendJson(res, 400, { ok:false, error:e.message }); }
    }
    // GET /api/stats
    if (req.method === "GET" && req.url.startsWith("/api/stats")) {
      if (!require()) return;
      const url = new URL(req.url, "http://x");
      const tier = String(url.searchParams.get("tier") || user.tier || "");
      if (!["cet4","cet6"].includes(tier)) return sendJson(res, 400, { ok:false, error:"bad tier" });
      return sendJson(res, 200, stats(user.key, tier));
    }
    // POST /api/reset
    if (req.method === "POST" && req.url === "/api/reset") {
      if (!require()) return;
      const n = deleteProgressForUser(user.key);
      return sendJson(res, 200, { ok:true, deleted:n });
    }
    // 404
    sendJson(res, 404, { ok:false, error: "not found" });
  } catch (e) {
    sendJson(res, 500, { ok:false, error: e.message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`vocab backend listening on :${PORT}`);
  console.log(`words: CET-4=${tierSize("cet4")} CET-6=${tierSize("cet6")}`);
  const gh = process.env.GH_TOKEN ? (process.env.GH_REPO || "SctrlB/vocab-backend") : "(ephemeral)";
  console.log(`persistence: ${gh === "(ephemeral)" ? "EPHEMERAL (no GH_TOKEN)" : "GitHub repo: " + gh}`);
});
