// api/analyze.js — Vercel Serverless Function (Node.js)
// Menerima prompt + gambar dari browser, memanggil model vision, mengembalikan { text }.
// API key HANYA dibaca dari Environment Variables Vercel (tidak pernah ada di browser/GitHub).

const MAX_IMAGES = 8;
const MAX_IMAGE_B64 = 4_000_000; // ~3 MB per gambar (base64)

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Gunakan metode POST." });

  // Mode 1: API key pribadi pengguna (dipakai untuk permintaan ini saja, tidak disimpan/dicatat).
  // Mode 2: key milik server, hanya dengan kode akses (dan hanya jika ACCESS_CODE diatur).
  const user = readUserCreds(req);
  if (user.error) return res.status(400).json({ error: user.error });
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!user.key && !bearer) {
    const required = process.env.ACCESS_CODE;
    if (!required) return res.status(403).json({ error: "Mode server dinonaktifkan. Isi API key pribadi di menu Settings." });
    if (req.headers["x-access-code"] !== required) {
      return res.status(401).json({ error: "Kode akses salah atau belum diisi. Isi kode akses, atau pakai API key pribadi di menu Settings." });
    }
  }

  const { prompt, images = [], json = false } = req.body || {};
  if (typeof prompt !== "string" || !prompt || prompt.length > 20000) {
    return res.status(400).json({ error: "Prompt tidak valid." });
  }
  if (!Array.isArray(images) || images.length > MAX_IMAGES) {
    return res.status(400).json({ error: "Maksimal " + MAX_IMAGES + " gambar." });
  }
  for (const im of images) {
    const ok = im && /^image\/(jpeg|png|webp|gif)$/.test(im.mime) &&
      typeof im.data === "string" && im.data.length <= MAX_IMAGE_B64;
    if (!ok) return res.status(400).json({ error: "Format atau ukuran gambar tidak valid." });
  }

  // Mode akun: login Supabase + jatah harian (memakai key server). Jatah dipotong dulu, dikembalikan jika gagal.
  let acct = null;
  if (!user.key && bearer) {
    acct = await accountGate(bearer);
    if (acct.error) return res.status(acct.status).json({ error: acct.error, quota_exceeded: !!acct.quotaExceeded });
  }

  try {
    const provider = user.key ? user.provider : (process.env.PROVIDER || "gemini").toLowerCase();
    const cfg = { key: user.key || "", model: user.model || "" };
    const text = provider === "claude"
      ? await callClaude(prompt, images, json, cfg)
      : await callGemini(prompt, images, json, cfg);
    return res.status(200).json(acct ? { text, quota: acct.quota } : { text });
  } catch (e) {
    const m = String(e.message).split(user.key || "\u0000").join("***"); // sembunyikan key pengguna
    console.error("analyze error:", m);
    if (acct && acct.user) await rpc("refund_quota", { p_user: acct.user.id }).catch(() => {});
    if (e.status === 429) return res.status(429).json({ error: "Batas pemakaian model tercapai. Coba lagi nanti." });
    if (e.code === "CONFIG") return res.status(500).json({ error: "Server belum dikonfigurasi (cek Environment Variables, atau isi ID model di Settings)." });
    return res.status(502).json({ error: "Penyedia model gagal merespons. [" + m.slice(0, 250) + "]" });
  }
};

async function callClaude(prompt, images, json, cfg) {
  const key = cfg.key || process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error("ANTHROPIC_API_KEY kosong"), { code: "CONFIG" });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: cfg.model || process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
      max_tokens: json ? 8000 : 2000,
      messages: [{ role: "user", content: [
        ...images.map(i => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } })),
        { type: "text", text: prompt }
      ] }]
    })
  });
  if (!r.ok) throw await providerError("claude", r);
  const d = await r.json();
  return (d.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Coba ulang otomatis saat Google sibuk (500/503), lalu model cadangan jika GEMINI_FALLBACK_MODEL diisi.
async function callGemini(prompt, images, json, cfg) {
  const key = cfg.key || process.env.GEMINI_API_KEY, primary = cfg.model || process.env.GEMINI_MODEL;
  if (!key || !primary) throw Object.assign(new Error("GEMINI_API_KEY/GEMINI_MODEL kosong"), { code: "CONFIG" });
  const models = [primary];
  const fb = process.env.GEMINI_FALLBACK_MODEL;
  if (fb && fb !== primary) models.push(fb);
  let last;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await geminiOnce(model, key, prompt, images, json); }
      catch (e) {
        last = e;
        if (e.status === 500 || e.status === 503) { if (attempt === 0) await sleep(2000); continue; }
        break; // error lain: lanjut ke model cadangan (jika ada)
      }
    }
  }
  throw last;
}

async function geminiOnce(model, key, prompt, images, json) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent";
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ parts: [
        ...images.map(i => ({ inline_data: { mime_type: i.mime, data: i.data } })),
        { text: prompt }
      ] }],
      generationConfig: json ? { responseMimeType: "application/json" } : {}
    })
  });
  if (!r.ok) throw await providerError("gemini", r);
  const d = await r.json();
  return ((d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [])
    .map(p => p.text || "").join("");
}

// Membaca pesan error dari penyedia (tanpa key) agar mudah didiagnosis.
async function providerError(name, r) {
  let msg = "";
  try { msg = (await r.text()).replace(/\s+/g, " ").replace(/AIza[0-9A-Za-z_-]{20,}/g, "***").slice(0, 200); } catch (_) {}
  return Object.assign(new Error(name + " " + r.status + ": " + msg), { status: r.status });
}

function readUserCreds(req) {
  const key = String(req.headers["x-user-key"] || "").trim();
  if (!key) return {};
  const provider = String(req.headers["x-user-provider"] || "gemini").toLowerCase();
  const model = String(req.headers["x-user-model"] || "").trim();
  if (!/^[\w.:~-]{8,400}$/.test(key)) return { error: "Format API key tidak valid." };
  if (provider !== "gemini" && provider !== "claude") return { error: "Penyedia tidak dikenal." };
  if (model && !/^[A-Za-z0-9._-]{1,80}$/.test(model)) return { error: "ID model tidak valid." };
  return { key, provider, model };
}

// ---------- Supabase: verifikasi login + jatah harian ----------
function sbEnv() {
  return {
    url: (process.env.SUPABASE_URL || "").replace(/\/$/, ""),
    anon: process.env.SUPABASE_ANON_KEY || "",
    svc: process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  };
}

async function rpc(name, body) {
  const { url, svc } = sbEnv();
  const headers = { "content-type": "application/json", apikey: svc };
  if (svc.startsWith("eyJ")) headers.Authorization = "Bearer " + svc; // kunci lama berbentuk JWT
  const r = await fetch(url + "/rest/v1/rpc/" + name, { method: "POST", headers, body: JSON.stringify(body) });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

async function accountGate(token) {
  const { url, anon, svc } = sbEnv();
  if (!url || !anon || !svc) return { status: 503, error: "Mode akun belum dikonfigurasi di server." };
  let u;
  try {
    const r = await fetch(url + "/auth/v1/user", { headers: { apikey: anon, Authorization: "Bearer " + token } });
    if (!r.ok) return { status: 401, error: "Sesi login tidak valid. Masuk lagi di Settings." };
    u = await r.json();
  } catch (_) {
    return { status: 502, error: "Tidak bisa memeriksa login." };
  }
  if (!u || !u.id) return { status: 401, error: "Sesi login tidak valid. Masuk lagi di Settings." };

  const limit = Math.max(1, parseInt(process.env.DAILY_LIMIT, 10) || 5);
  const global = Math.max(1, parseInt(process.env.GLOBAL_DAILY_LIMIT, 10) || 100);
  const q = await rpc("consume_quota", { p_user: u.id, p_limit: limit, p_global: global });
  if (!q) return { status: 502, error: "Gagal memeriksa jatah harian." };
  if (!q.ok) {
    return {
      status: 429, quotaExceeded: true,
      error: q.reason === "global"
        ? "Kapasitas harian aplikasi sudah penuh. Coba lagi besok, atau pakai API key pribadi di Settings."
        : "Jatah harian Anda (" + limit + " analisis) sudah habis. Coba lagi besok, atau pakai API key pribadi di Settings."
    };
  }
  return { user: u, quota: { used: q.used, limit, remaining: Math.max(0, limit - q.used) } };
}
