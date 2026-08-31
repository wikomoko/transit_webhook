const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 7272;

// Terima body JSON maupun form-urlencoded, dan tetap terima meski
// Content-Type tidak diset dengan benar oleh pengirim webhook.
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));
app.use(express.text({ type: "*/*", limit: "5mb" }));

const DATA_DIR = path.join(__dirname, "data");

/**
 * Simpan payload yang masuk ke file .txt (isi dalam format JSON).
 * Satu request = satu file, supaya tidak ada konflik tulis-menulis
 * saat banyak request masuk bersamaan.
 */
function saveIncoming(endpointName, req) {
  const dir = path.join(DATA_DIR, endpointName);
  fs.mkdirSync(dir, { recursive: true });

  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const filename = `${stamp}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const filePath = path.join(dir, filename);

  const record = {
    receivedAt: now.toISOString(),
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    headers: req.headers,
    query: req.query,
    body: req.body,
  };

  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), "utf8");
  return filePath;
}

function handleWebhook(endpointName) {
  return (req, res) => {
    try {
      const filePath = saveIncoming(endpointName, req);
      console.log(
        `[${endpointName}] ${req.method} ${req.originalUrl} data diterima -> ${filePath}`
      );
      res.status(200).json({ ok: true, message: "Data diterima" });
    } catch (err) {
      console.error(`[${endpointName}] gagal simpan data:`, err);
      res.status(500).json({ ok: false, message: "Gagal menyimpan data" });
    }
  };
}

app.post("/notification", handleWebhook("webhook1"));
app.post("/status", handleWebhook("webhook2"));

app.get("/", (req, res) => {
  res.send("Webhook server aktif. Endpoint: POST /webhook1, POST /webhook2");
});

// Tangkap semua request lain di luar /notification dan /status (path lain,
// atau method lain seperti GET/PUT ke path yang sama) supaya tetap
// tersimpan dan tercetak di log, bukan cuma 404 diam-diam.
app.all(/.*/, handleWebhook("lainnya"));

app.listen(PORT, () => {
  console.log(`Server jalan di http://localhost:${PORT}`);
  console.log(`- POST http://localhost:${PORT}/webhook1`);
  console.log(`- POST http://localhost:${PORT}/webhook2`);
});
