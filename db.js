// db.js — Vocab backend persistence layer.
// Storage strategy: in-memory cache backed by a single JSON blob in a GitHub repo
// (configured via env vars). Render's free tier has no persistent disk, so we use
// the deployment repo itself as a poor man's distributed KV store.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DB_PATH = process.env.DB_PATH || path.join(__dirname, "vocab.db");
export const WORDS_PATH = process.env.WORDS_PATH || path.join(__dirname, "words.json");

// ----- Words load (unchanged) -----
let wordsByTier;
try {
  wordsByTier = JSON.parse(fs.readFileSync(WORDS_PATH, "utf-8"));
} catch (e) {
  console.error("FATAL: cannot read words.json:", e.message);
  process.exit(1);
}
if (!wordsByTier.cet4 || !wordsByTier.cet6) {
  console.error("FATAL: words.json missing cet4 or cet6");
  process.exit(1);
}
console.log(`words loaded: CET-4=${wordsByTier.cet4.length} CET-6=${wordsByTier.cet6.length}`);

const wordLookup = new Map();
for (const arr of [wordsByTier.cet4, wordsByTier.cet6]) {
  for (const w of arr) wordLookup.set(w.w.toLowerCase(), { p: w.p, m: w.m });
}

export const tierSize = (tier) => (wordsByTier[tier]?.length) || 0;

// ----- In-memory store with GitHub persistence -----
// state shape:
//   users: { [key]: { key, tier, mode, createdAt, lastSeen, currentTier } }
//   progress: { [userKey]: { [word+tier key]: { word, tier, status, ease, intv, reps, dueAt, lastReviewed } } }

const GH_TOKEN  = process.env.GH_TOKEN || "";
const GH_REPO   = process.env.GH_REPO  || "SctrlB/vocab-backend";     // default repo
const STATE_PATH = process.env.STATE_PATH || "data/state.json";       // repo path

let state = { users: {}, progress: {} };
let stateSha = null; // GitHub blob sha for last known write
let writePending = false;
let writeTimer = null;

async function ghLoad() {
  if (!GH_TOKEN) {
    console.log("GH_TOKEN not set — running with ephemeral in-memory state only");
    return;
  }
  try {
    const url = `https://api.github.com/repos/${GH_REPO}/contents/${STATE_PATH}`;
    const r = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${GH_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "User-Agent": "vocab-backend",
      },
    });
    if (r.status === 404) {
      console.log(`no existing state at ${STATE_PATH}, starting fresh`);
      return;
    }
    if (!r.ok) {
      console.warn(`GitHub load returned ${r.status}, starting fresh`);
      return;
    }
    const j = await r.json();
    stateSha = j.sha;
    const decoded = Buffer.from(j.content, "base64").toString("utf-8");
    const loaded = JSON.parse(decoded);
    state.users    = loaded.users    || {};
    state.progress = loaded.progress || {};
    console.log(`loaded state: ${Object.keys(state.users).length} users, ${Object.keys(state.progress).reduce((n,k)=>n+Object.keys(state.progress[k]).length,0)} progress rows`);
  } catch (e) {
    console.warn("GitHub load failed:", e.message, "— starting fresh");
  }
}

async function ghFlush() {
  if (!GH_TOKEN) return;
  if (!writePending) return;
  writePending = false;
  try {
    const body = JSON.stringify({
      users: state.users,
      progress: state.progress,
      lastFlush: Date.now(),
    });
    const url = `https://api.github.com/repos/${GH_REPO}/contents/${STATE_PATH}`;
    const payload = {
      message: "sync: vocab progress state",
      content: Buffer.from(body, "utf-8").toString("base64"),
      branch: "main",
    };
    if (stateSha) payload.sha = stateSha;
    const r = await fetch(url, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${GH_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "vocab-backend",
      },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const txt = await r.text();
      console.warn("GitHub flush failed:", r.status, txt.slice(0, 200));
      return;
    }
    const j = await r.json();
    stateSha = j.content.sha;
    console.log(`flushed state: users=${Object.keys(state.users).length}, sha=${stateSha.slice(0,8)}`);
  } catch (e) {
    console.warn("GitHub flush error:", e.message, "type:", e.name, e.stack);
  }
}

function scheduleFlush(delay = 800) {
  writePending = true;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(async () => {
    writeTimer = null;
    console.log("[persist] timer fired, writePending=true, calling ghFlush()...");
    try {
      await ghFlush();
      console.log("[persist] ghFlush() returned");
    } catch (e) {
      console.error("[persist] ghFlush threw:", e.message, e.stack);
    }
  }, delay);
}

// Bulk flush on graceful shutdown
async function flushNow() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  writePending = true;
  await ghFlush();
}

// Synchronous-style flush using deasync-like pattern via Atomics + SharedArrayBuffer
// is overkill. Use sync HTTP via child_process for the final flush.

import { execSync } from "node:child_process";

function flushSync() {
  if (!writePending || !GH_TOKEN) return;
  const body = JSON.stringify({
    users: state.users,
    progress: state.progress,
    lastFlush: Date.now(),
  });
  const b64 = Buffer.from(body, "utf-8").toString("base64");
  // Build a tiny node one-liner that does the PUT
  const script = `
    const fetch_ = (...a) => globalThis.fetch(...a);
    const body_ = ${JSON.stringify(b64)};
    const sha_ = ${JSON.stringify(stateSha)};
    const repo_ = ${JSON.stringify(GH_REPO)};
    const sp = ${JSON.stringify(STATE_PATH)};
    const token_ = ${JSON.stringify(GH_TOKEN)};
    (async () => {
      const payload = { message: "sync: vocab progress state (sync flush)", content: body_, branch: "main" };
      if (sha_) payload.sha = sha_;
      const r = await fetch_(\`https://api.github.com/repos/\${repo_}/contents/\${sp}\`, {
        method: "PUT",
        headers: { "Authorization": "Bearer " + token_, "Content-Type": "application/json", "Accept": "application/vnd.github+json", "User-Agent": "vocab-backend-sync" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) { console.error("sync flush failed", r.status, (await r.text()).slice(0, 200)); process.exit(1); }
      const j = await r.json();
      console.log("sync flush ok", j.content.sha.slice(0,8));
    })();
  `;
  try {
    const nodePath = process.execPath;
    const r = execSync(`"${nodePath}" -e ${JSON.stringify(script)}`, {
      cwd: __dirname, encoding: "utf-8", timeout: 10000,
    });
    console.log("sync flush result:", r.trim());
  } catch (e) {
    console.error("sync flush error:", e.message);
  }
}

process.on("beforeExit", () => { flushSync(); });
process.on("exit",     () => { flushSync(); });
// On Windows, SIGTERM may bypass handlers — flushSync covers exit, beforeExit covers normal exit.

// Initial load (kick off but don't await — boot quickly)
ghLoad();

// ----- Public API -----
function newKey() {
  const r = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0").toLowerCase();
  return "kid-" + r.slice(0,4) + "-" + r.slice(4,8);
}

export function getOrCreateUser(key) {
  const now = Date.now();
  if (state.users[key]) {
    state.users[key].lastSeen = now;
    scheduleFlush();
    return state.users[key];
  }
  const u = { key, tier: null, mode: null, createdAt: now, lastSeen: now };
  state.users[key] = u;
  if (!state.progress[key]) state.progress[key] = {};
  scheduleFlush();
  return u;
}

export function getUser(key) {
  return state.users[key] || null;
}

function progKey(word, tier) { return `${tier}::${word.toLowerCase()}`; }

export function initProgress(uid_key, tier, mode) {
  const total = tierSize(tier);
  if (!total) throw new Error("unknown tier: " + tier);
  if (![15, 30, 60].includes(mode)) throw new Error("mode must be 15/30/60");
  const userProg = state.progress[uid_key] || (state.progress[uid_key] = {});
  const existing = Object.keys(userProg).filter(k => k.startsWith(tier+"::")).length;
  if (existing > 0) {
    const u = state.users[uid_key];
    return { total: existing, already: true, daily_target: Math.ceil(existing / (u?.mode || mode)) };
  }
  const bucketSize = Math.ceil(total / mode);
  const start = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
  const DAY_MS = 86400000;
  const arr = wordsByTier[tier];
  for (let i = 0; i < total; i++) {
    const bucketIndex = Math.min(mode - 1, Math.floor(i / bucketSize));
    const w = arr[i].w;
    const k = progKey(w, tier);
    userProg[k] = {
      word: w, tier,
      status: "learning",
      ease: 2.5, intv: 0, reps: 0,
      dueAt: start + bucketIndex * DAY_MS,
      lastReviewed: null,
    };
  }
  state.users[uid_key].tier = tier;
  state.users[uid_key].mode = mode;
  scheduleFlush();
  return { total, already: false, daily_target: bucketSize };
}

export function dueItems(uid_key, tier, limit = 50) {
  const now = Date.now();
  const DAY_MS = 86400000;
  const endOfToday = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime() + DAY_MS; })();
  const userProg = state.progress[uid_key] || {};
  const rows = [];
  for (const k of Object.keys(userProg)) {
    const p = userProg[k];
    if (p.tier !== tier) continue;
    if (p.status === "known") continue;
    if (p.dueAt > now) continue;
    if (p.dueAt >= endOfToday) continue;
    rows.push(p);
  }
  rows.sort((a,b) => {
    const al = a.status === "learning" ? 0 : 1;
    const bl = b.status === "learning" ? 0 : 1;
    if (al !== bl) return al - bl;
    return a.dueAt - b.dueAt;
  });
  return rows.slice(0, Math.min(limit, 100)).map(p => {
    const info = wordLookup.get(p.word.toLowerCase()) || {};
    return { word: p.word, phonetic: info.p || "", meaning: info.m || "", status: p.status, due_at: p.dueAt };
  });
}

export function todayItems(uid_key, tier) {
  const DAY_MS = 86400000;
  const start = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
  const end = start + DAY_MS;
  const userProg = state.progress[uid_key] || {};
  const rows = [];
  for (const k of Object.keys(userProg)) {
    const p = userProg[k];
    if (p.tier !== tier) continue;
    if (p.status === "known") continue;   // skip already-known words
    if (p.dueAt < start || p.dueAt >= end) continue;
    rows.push(p);
  }
  rows.sort((a,b) => a.dueAt - b.dueAt || (a.word < b.word ? -1 : 1));
  return rows.map(p => {
    const info = wordLookup.get(p.word.toLowerCase()) || {};
    return { word: p.word, phonetic: info.p || "", meaning: info.m || "", status: p.status, due_at: p.dueAt, last_reviewed: p.lastReviewed };
  });
}

export function gradeWord(uid_key, word, tier, grade) {
  const userProg = state.progress[uid_key];
  if (!userProg) throw new Error("no user progress");
  const k = progKey(word, tier);
  const p = userProg[k];
  if (!p) throw new Error("no progress for that word: " + word);
  const now = Date.now();
  const DAY_MS = 86400000;
  const clamp = v => Math.max(1.3, Math.min(3.0, v));

  if (grade === "known") {
    p.status = "known"; p.intv = 365; p.reps++;
  } else if (grade === "again") {
    p.status = "learning"; p.ease = clamp(p.ease - 0.2); p.intv = 0; p.reps = 0;
    p.dueAt = now + 10*60*1000;
    scheduleFlush();
    return { ok: true, status: p.status, interval_days: 0, next_due_at: p.dueAt };
  } else if (grade === "hard") {
    p.status = "learning"; p.ease = clamp(p.ease - 0.15);
    p.intv = Math.max(1, Math.round(p.intv * 1.2));
    p.dueAt = now + p.intv * DAY_MS;
  } else if (grade === "good") {
    p.status = "learning";
    if (p.reps === 0) p.intv = 1;
    else if (p.reps === 1) p.intv = 3;
    else p.intv = Math.max(1, Math.round(p.intv * p.ease));
    p.reps++;
    p.dueAt = now + p.intv * DAY_MS;
  } else if (grade === "easy") {
    p.status = "learning"; p.intv = Math.max(3, Math.round(p.intv * p.ease) + 2);
    p.ease = clamp(p.ease + 0.15); p.reps++;
    p.dueAt = now + p.intv * DAY_MS;
  } else {
    throw new Error("unknown grade: " + grade);
  }
  p.lastReviewed = now;
  scheduleFlush();
  return { ok: true, status: p.status, interval_days: p.intv, next_due_at: p.dueAt };
}

export function stats(uid_key, tier) {
  const userProg = state.progress[uid_key] || {};
  const DAY_MS = 86400000;
  const tomorrow0 = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime() + DAY_MS; })();
  let total = 0, known = 0, learning = 0, dueToday = 0;
  const days = new Set();
  for (const k of Object.keys(userProg)) {
    const p = userProg[k];
    if (p.tier !== tier) continue;
    total++;
    if (p.status === "known") known++;
    else learning++;
    if (p.status !== "known" && p.dueAt <= tomorrow0) dueToday++;
    if (p.lastReviewed) {
      const t = new Date(p.lastReviewed); t.setHours(0,0,0,0); days.add(t.getTime());
    }
  }
  let streak = 0;
  let cursor = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
  while (days.has(cursor)) { streak++; cursor -= DAY_MS; }
  return { ok: true, total, known_count: known, learning_count: learning, due_today: dueToday, streak_days: streak };
}

export function deleteProgressForUser(uid_key) {
  const userProg = state.progress[uid_key];
  const n = userProg ? Object.keys(userProg).length : 0;
  state.progress[uid_key] = {};
  scheduleFlush();
  return n;
}
