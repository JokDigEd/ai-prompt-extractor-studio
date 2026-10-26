// api/analyze.js — Vercel Serverless Function (Node.js)
// Menerima prompt + gambar dari browser, memanggil model vision, mengembalikan { text }.
// API key HANYA dibaca dari Environment Variables Vercel (tidak pernah ada di browser/GitHub).

const MAX_IMAGES = 8;
const MAX_IMAGE_B64 = 4_000_000; // ~3 MB per gambar (base64)

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Gunakan metode POST." });

  const required = process.env.ACCESS_CODE;
  if (required && req.headers["x-access-code"] !== required) {
    return res.status(401).json({ error: "Kode akses salah atau belum diisi (menu Settings)." });
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

  try {
    const provider = (process.env.PROVIDER || "gemini").toLowerCase();
    const text = provider === "claude"
      ? await callClaude(prompt, images, json)
      : await callGemini(prompt, images, json);
    return res.status(200).json({ text });
  } catch (e) {
    console.error("analyze error:", e.message); // tidak mencatat key atau gambar
    if (e.status === 429) return res.status(429).json({ error: "Batas pemakaian model tercapai. Coba lagi nanti." });
    if (e.code === "CONFIG") return res.status(500).json({ error: "Server belum dikonfigurasi (cek Environment Variables)." });
    return res.status(502).json({ error: "Penyedia model gagal merespons." });
  }
};

async function callClaude(prompt, images, json) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error("ANTHROPIC_API_KEY kosong"), { code: "CONFIG" });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
      max_tokens: json ? 8000 : 2000,
      messages: [{ role: "user", content: [
        ...images.map(i => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } })),
        { type: "text", text: prompt }
      ] }]
    })
  });
  if (!r.ok) throw Object.assign(new Error("claude " + r.status), { status: r.status });
  const d = await r.json();
  return (d.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}

async function callGemini(prompt, images, json) {
  const key = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL;
  if (!key || !model) throw Object.assign(new Error("GEMINI_API_KEY/GEMINI_MODEL kosong"), { code: "CONFIG" });
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
  if (!r.ok) throw Object.assign(new Error("gemini " + r.status), { status: r.status });
  const d = await r.json();
  return ((d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [])
    .map(p => p.text || "").join("");
}
