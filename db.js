// db.js — SQLite layer for vocab backend
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.DB_PATH || path.join(__dirname, "vocab.db");
export const WORDS_PATH = process.env.WORDS_PATH || path.join(__dirname, "words.json");

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
db.exec(schema);

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

const stmts = {
  getUserByKey: db.prepare("SELECT uid, key, tier, mode, created_at, last_seen FROM users WHERE key = ?"),
  insertUser: db.prepare("INSERT INTO users (key, created_at, last_seen) VALUES (?, ?, ?)"),
  touchUser: db.prepare("UPDATE users SET last_seen = ? WHERE uid = ?"),
  setUserActive: db.prepare("UPDATE users SET tier = ?, mode = ? WHERE uid = ?"),
  countProgress: db.prepare("SELECT COUNT(*) AS c FROM progress WHERE uid = ?"),
  insertProgress: db.prepare(`
    INSERT OR IGNORE INTO progress (uid, word, tier, status, ease, interval_days, repetitions, due_at, last_reviewed)
    VALUES (?, ?, ?, 'learning', 2.5, 0, 0, ?, NULL)
  `),
  getProgress: db.prepare("SELECT * FROM progress WHERE uid = ? AND word = ? AND tier = ?"),
  updateProgress: db.prepare(`
    UPDATE progress SET status=?, ease=?, interval_days=?, repetitions=?, due_at=?, last_reviewed=?
    WHERE uid=? AND word=? AND tier=?
  `),
  dueItems: db.prepare(`
    SELECT word, status, due_at, last_reviewed FROM progress
    WHERE uid=? AND tier=? AND due_at<=? AND status!='known' AND due_at<?
    ORDER BY (status='learning') DESC, due_at ASC
    LIMIT ?
  `),
  todayItems: db.prepare(`
    SELECT word, status, due_at, last_reviewed FROM progress
    WHERE uid=? AND tier=? AND due_at>=? AND due_at<? ORDER BY due_at ASC, word ASC
  `),
  statsOverall: db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status='known' THEN 1 ELSE 0 END) AS known_count,
           SUM(CASE WHEN status='learning' THEN 1 ELSE 0 END) AS learning_count
    FROM progress WHERE uid=? AND tier=?
  `),
  dueTodayCount: db.prepare(`SELECT COUNT(*) AS c FROM progress WHERE uid=? AND tier=? AND due_at<=? AND status!='known'`),
  deleteProgress: db.prepare("DELETE FROM progress WHERE uid=?"),
};

const DAY_MS = 86400000;
function startOfDay(t = Date.now()) {
  const d = new Date(t); d.setHours(0,0,0,0); return d.getTime();
}

export function getOrCreateUser(key) {
  let row = stmts.getUserByKey.get(key);
  if (row) {
    stmts.touchUser.run(Date.now(), row.uid);
    row.last_seen = Date.now();
    return row;
  }
  const now = Date.now();
  const r = stmts.insertUser.run(key, now, now);
  return stmts.getUserByKey.get(key);
}

export function getUser(key) {
  return stmts.getUserByKey.get(key);
}

export function initProgress(uid, tier, mode) {
  const total = tierSize(tier);
  if (!total) throw new Error("unknown tier: " + tier);
  if (![15,30,60].includes(mode)) throw new Error("mode must be 15/30/60");
  const existing = stmts.countProgress.get(uid).c;
  if (existing > 0) {
    const u = db.prepare("SELECT tier, mode FROM users WHERE uid=?").get(uid);
    return { total: existing, already: true, daily_target: Math.ceil(existing / (u?.mode || mode)) };
  }
  const bucketSize = Math.ceil(total / mode);
  const start = startOfDay();
  const txn = db.transaction(() => {
    const arr = wordsByTier[tier];
    for (let i = 0; i < total; i++) {
      const bucketIndex = Math.min(mode - 1, Math.floor(i / bucketSize));
      stmts.insertProgress.run(uid, arr[i].w, tier, start + bucketIndex * DAY_MS);
    }
    stmts.setUserActive.run(tier, mode, uid);
  });
  txn();
  return { total, already: false, daily_target: bucketSize };
}

export function dueItems(uid, tier, limit = 50) {
  const now = Date.now();
  const endOfToday = startOfDay(now) + DAY_MS;
  const rows = stmts.dueItems.all(uid, tier, now, endOfToday, limit);
  return rows.map(r => {
    const info = wordLookup.get(r.word.toLowerCase()) || {};
    return { word: r.word, phonetic: info.p || "", meaning: info.m || "", status: r.status, due_at: r.due_at };
  });
}

export function todayItems(uid, tier) {
  const start = startOfDay();
  const end = start + DAY_MS;
  const rows = stmts.todayItems.all(uid, tier, start, end);
  return rows.map(r => {
    const info = wordLookup.get(r.word.toLowerCase()) || {};
    return { word: r.word, phonetic: info.p || "", meaning: info.m || "", status: r.status, due_at: r.due_at, last_reviewed: r.last_reviewed };
  });
}

export function gradeWord(uid, word, tier, grade) {
  const row = stmts.getProgress.get(uid, word, tier);
  if (!row) throw new Error("no progress for that word: " + word);
  const now = Date.now();
  let { ease, interval_days: intv, repetitions } = row;
  const clamp = v => Math.max(1.3, Math.min(3.0, v));
  let status;

  if (grade === "known") {
    status = "known"; intv = 365; repetitions++;
  } else if (grade === "again") {
    status = "learning"; ease = clamp(ease - 0.2); intv = 0; repetitions = 0;
    stmts.updateProgress.run(status, ease, intv, repetitions, now + 10*60*1000, now, uid, word, tier);
    return { ok: true, status, interval_days: 0, next_due_at: now + 10*60*1000 };
  } else if (grade === "hard") {
    status = "learning"; ease = clamp(ease - 0.15); intv = Math.max(1, Math.round(intv * 1.2));
  } else if (grade === "good") {
    status = "learning";
    if (repetitions === 0) intv = 1;
    else if (repetitions === 1) intv = 3;
    else intv = Math.max(1, Math.round(intv * ease));
    repetitions++;
  } else if (grade === "easy") {
    status = "learning"; intv = Math.max(3, Math.round(intv * ease) + 2);
    ease = clamp(ease + 0.15); repetitions++;
  } else {
    throw new Error("unknown grade: " + grade);
  }

  const nextDueAt = (grade === "hard" || grade === "good" || grade === "easy")
    ? now + intv * DAY_MS
    : now;
  stmts.updateProgress.run(status, ease, intv, repetitions, nextDueAt, now, uid, word, tier);
  return { ok: true, status, interval_days: intv, next_due_at: nextDueAt };
}

export function stats(uid, tier) {
  const s = stmts.statsOverall.get(uid, tier);
  const total = s.total || 0;
  const known = s.known_count || 0;
  const learning = s.learning_count || 0;
  const tomorrow0 = startOfDay() + DAY_MS;
  const dueToday = stmts.dueTodayCount.get(uid, tier, tomorrow0).c;

  const rows = db.prepare(`
    SELECT DISTINCT last_reviewed FROM progress WHERE uid=? AND tier=? AND last_reviewed IS NOT NULL
  `).all(uid, tier);
  const days = new Set();
  for (const r of rows) {
    const t = new Date(r.last_reviewed); t.setHours(0,0,0,0); days.add(t.getTime());
  }
  let streak = 0;
  let cursor = startOfDay();
  while (days.has(cursor)) { streak++; cursor -= DAY_MS; }

  return { ok: true, total, known_count: known, learning_count: learning, due_today: dueToday, streak_days: streak };
}

export function deleteProgressForUser(uid) {
  const r = stmts.deleteProgress.run(uid);
  return r.changes;
}
