// REALMS OF RUIN — таблица рекордов для Telegram Mini App (Netlify Functions + Netlify Blobs)
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

export const config = { path: "/api/scores" };

const CLASSES = 7;
const MAX_ROWS = 100;
let cache = null; // { t, users }

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS },
  });

function botToken() {
  try { if (globalThis.Netlify?.env?.get) return Netlify.env.get("BOT_TOKEN") || ""; } catch (_) {}
  return process.env.BOT_TOKEN || "";
}

// Проверка подписи Telegram initData: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export function verifyInitData(initData, token, maxAgeSec = 3 * 86400) {
  if (!token) return { error: "no_token" };
  if (!initData) return { error: "no_initdata" };
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return { error: "no_hash" };
  p.delete("hash");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token.trim()).digest();
  const sign = (pairs) => crypto.createHmac("sha256", secret)
    .update(pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => k + "=" + v).join("\n"))
    .digest("hex");
  const all = [...p.entries()];
  // Telegram в разное время считал hash и с полем signature, и без него — принимаем оба варианта.
  const ok = [sign(all.slice()), sign(all.filter(([k]) => k !== "signature"))]
    .some((h) => h.length === hash.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash)));
  if (!ok) return { error: "bad_hash" };
  const auth = Number(p.get("auth_date"));
  if (!auth || Date.now() / 1000 - auth > maxAgeSec) return { error: "expired" };
  try { const u = JSON.parse(p.get("user") || "null"); return u && u.id ? { user: u } : { error: "no_user" }; } catch (_) { return { error: "no_user" }; }
}

// Очки считаются на сервере из составляющих — клиентскому «score» не доверяем.
export function scoreOf(r) {
  return r.k * 5 + r.l * 80 + r.a * 100 + r.b * 1000 + (r.w ? 5000 : 0) + Math.min(3600, Math.floor(r.t));
}

export function sanitize(body) {
  const n = (v, lo, hi) => { v = Number(v); if (!Number.isFinite(v)) return null; return Math.max(lo, Math.min(hi, Math.floor(v))); };
  const r = {
    c: n(body.cls, 0, CLASSES - 1), l: n(body.level, 1, 80), k: n(body.kills, 0, 100000),
    t: n(body.time, 0, 6 * 3600), a: n(body.area, 1, 32), b: n(body.bosses, 0, 3), w: body.win ? 1 : 0,
  };
  if (Object.values(r).some((v) => v === null)) return null;
  // правдоподобие
  if (r.k > r.t * 4 + 60) return null;
  if (r.l > 8 + r.t / 20) return null;
  if (r.w && (r.a < 30 || r.b < 1)) return null;
  r.s = scoreOf(r);
  r.d = Date.now();
  return r;
}

const displayName = (u) => {
  let n = String(u.first_name || "").trim();
  if (u.last_name) n += " " + String(u.last_name).trim()[0] + ".";
  if (!n) n = u.username ? "@" + u.username : "Игрок";
  return n.replace(/[\u0000-\u001f<>]/g, "").slice(0, 24);
};

async function loadAll(store) {
  if (cache && Date.now() - cache.t < 15000) return cache.users;
  const { blobs } = await store.list({ prefix: "u/" });
  const users = (await Promise.all(blobs.slice(0, 3000).map((b) => store.get(b.key, { type: "json" }).catch(() => null)))).filter(Boolean);
  cache = { t: Date.now(), users };
  return users;
}

function board(users, cls, meId) {
  const rows = [];
  for (const u of users) {
    let best = null;
    if (cls === "all") { for (const k in u.best || {}) { const r = u.best[k]; if (!best || r.s > best.s) best = r; } }
    else best = (u.best || {})[cls] || null;
    if (best) rows.push({ id: u.id, n: u.n, ...best });
  }
  rows.sort((a, b) => b.s - a.s || a.d - b.d);
  const meIdx = meId ? rows.findIndex((r) => String(r.id) === String(meId)) : -1;
  const strip = (r, i) => ({ p: i + 1, n: r.n, c: r.c, s: r.s, l: r.l, k: r.k, t: r.t, a: r.a, w: r.w, me: String(r.id) === String(meId) ? 1 : 0 });
  return {
    total: rows.length,
    top: rows.slice(0, MAX_ROWS).map(strip),
    me: meIdx >= 0 ? strip(rows[meIdx], meIdx) : null,
  };
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const store = getStore("ror-scores");
  const url = new URL(req.url);
  try {
    if (req.method === "GET" && url.searchParams.has("check")) {
      const t = botToken().trim();
      return json({ ok: true, token: !!t, bot: t ? t.split(":")[0] : null, version: 2 });
    }
    if (req.method === "GET") {
      const cls = url.searchParams.get("cls") || "all";
      const c = cls === "all" ? "all" : String(Math.max(0, Math.min(CLASSES - 1, Number(cls) | 0)));
      return json({ ok: true, ...board(await loadAll(store), c, url.searchParams.get("me")) });
    }
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const v = verifyInitData(body.initData, botToken());
      if (!v.user) return json({ ok: false, error: v.error }, 401);
      const user = v.user;
      const r = sanitize(body);
      if (!r) return json({ ok: false, error: "bad" }, 400);
      const key = "u/" + user.id;
      const prev = (await store.get(key, { type: "json" })) || { id: user.id, best: {} };
      prev.n = displayName(user);
      const old = prev.best[r.c];
      const improved = !old || r.s > old.s;
      if (improved) prev.best[r.c] = r;
      prev.seen = Date.now();
      await store.setJSON(key, prev);
      cache = null;
      return json({ ok: true, improved, score: r.s, best: prev.best[r.c].s });
    }
    return json({ ok: false, error: "method" }, 405);
  } catch (e) {
    return json({ ok: false, error: "server" }, 500);
  }
};
