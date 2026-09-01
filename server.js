// quiet: true -- dotenv v17 by default prints a random self-promo "tip" line
// to stdout after loading; itu bukan bug, tapi kita matikan biar log server
// tetap bersih cuma isi log request beneran.
require('dotenv').config({ quiet: true });

const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const qrcode = require('qrcode');

const { Dana } = require('dana-node');
const {
  WidgetUtils,
  Oauth2UrlDataModeEnum,
  ApplyTokenAuthorizationCodeRequestGrantTypeEnum,
  ApplyOTTRequestUserResourcesEnum,
  EnvInfoTerminalTypeEnum,
  UrlParamTypeEnum,
} = require('dana-node/widget/v1');

const app = express();
const PORT = process.env.PORT || 7272;

// Domain publik yang terdaftar sebagai "Finish Redirect URL" / "Finish Payment URL"
// di dashboard DANA. redirectUrl yang dikirim ke generateOauthUrl HARUS match
// dengan yang terdaftar di sana, makanya path callback dipasang di root ("/"),
// bukan di sub-path custom seperti /oauth/callback.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://paymentnotification.hiddenproject.my.id').replace(/\/+$/, '');

// Terima body JSON maupun form-urlencoded, dan tetap terima meski
// Content-Type tidak diset dengan benar oleh pengirim webhook.
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.text({ type: '*/*', limit: '5mb' }));

const DATA_DIR = path.join(__dirname, 'data');

/**
 * Simpan payload yang masuk ke file .txt (isi dalam format JSON).
 * Satu request = satu file, supaya tidak ada konflik tulis-menulis
 * saat banyak request masuk bersamaan.
 */
function saveIncoming(endpointName, req) {
  const dir = path.join(DATA_DIR, endpointName);
  fs.mkdirSync(dir, { recursive: true });

  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
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

  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8');
  return filePath;
}

function handleWebhook(endpointName) {
  return (req, res) => {
    try {
      const filePath = saveIncoming(endpointName, req);
      console.log(
        `[${endpointName}] ${req.method} ${req.originalUrl} data diterima -> ${filePath}`
      );
      // Param bisa datang lewat query string (biasa dipakai kalau pihak
      // ketiga hit pakai GET, mis. redirect/callback dengan authCode, state,
      // dll di URL) atau lewat body (kalau pihak ketiga hit pakai POST).
      // Cetak dua-duanya biar kelihatan di log, bukan cuma tersimpan di file.
      if (req.query && Object.keys(req.query).length > 0) {
        console.log(`[${endpointName}] query:`, req.query);
      }
      if (req.body && Object.keys(req.body).length > 0) {
        console.log(`[${endpointName}] body:`, req.body);
      }
      res.status(200).json({ ok: true, message: 'Data diterima' });
    } catch (err) {
      console.error(`[${endpointName}] gagal simpan data:`, err);
      res.status(500).json({ ok: false, message: 'Gagal menyimpan data' });
    }
  };
}

// ---------------------------------------------------------------------------
// DANA client + helper waktu Jakarta (dipindah dari examples/widget-seamless-
// binding.js punya dana-node, dipakai sekali di sini biar seamless binding
// jalan otomatis dari server, bukan lewat script CLI manual)
// ---------------------------------------------------------------------------

const privateKey = process.env.PRIVATE_KEY
  || (process.env.PRIVATE_KEY_PATH && fs.readFileSync(process.env.PRIVATE_KEY_PATH, 'utf8'));

let danaClient = null;
let widgetApi = null;
if (privateKey && process.env.X_PARTNER_ID) {
  danaClient = new Dana({
    partnerId: process.env.X_PARTNER_ID,
    privateKey,
    origin: process.env.ORIGIN,
    env: process.env.DANA_ENV || 'sandbox',
  });
  widgetApi = danaClient.widgetApi;
} else {
  console.warn(
    '[dana] PRIVATE_KEY/PRIVATE_KEY_PATH atau X_PARTNER_ID belum diisi di .env -- ' +
    'endpoint /binding/start dan callback binding tidak akan berfungsi sampai diisi.'
  );
}

// Format waktu Jakarta (UTC+7, tidak ada DST) sebagai YYYY-MM-DDTHH:mm:ss+07:00.
// Sandbox DANA menolak validUpTo yang lebih dari 30 menit ke depan, jadi
// nilainya dihitung dari waktu sekarang, bukan di-hardcode.
function getValidUpTo(minutesFromNow) {
  const target = new Date(Date.now() + minutesFromNow * 60 * 1000);
  const jakarta = new Date(target.getTime() + 7 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${jakarta.getUTCFullYear()}-${pad(jakarta.getUTCMonth() + 1)}-${pad(jakarta.getUTCDate())}`
    + `T${pad(jakarta.getUTCHours())}:${pad(jakarta.getUTCMinutes())}:${pad(jakarta.getUTCSeconds())}+07:00`;
}

function getNowJakarta() {
  return getValidUpTo(0);
}

// ---------------------------------------------------------------------------
// Pending binding store: nyimpen state seamless binding yang lagi jalan,
// key-nya `state` random per request supaya callback tau ini punya request
// yang mana (dan authCode yang masuk itu untuk siapa). In-memory saja --
// cukup untuk single-instance server; kalau nanti scale ke multi-instance,
// ganti ke Redis/DB.
// ---------------------------------------------------------------------------

const pendingBindings = new Map();
// Reverse index: partnerReferenceNo (dibuat saat widgetPayment) -> state, supaya
// callback yang cuma bawa partnerReferenceNo (Finish Payment redirect di /status,
// Finish Notify S2S di /notification) bisa dicocokkan balik ke order/timeline-nya.
const partnerRefIndex = new Map();
const PENDING_TTL_MS = 30 * 60 * 1000; // 30 menit, sejalan sama batas validUpTo sandbox

setInterval(() => {
  const now = Date.now();
  for (const [state, record] of pendingBindings) {
    if (now - record.createdAt > PENDING_TTL_MS) {
      pendingBindings.delete(state);
      if (record.partnerReferenceNo) partnerRefIndex.delete(record.partnerReferenceNo);
    }
  }
}, 5 * 60 * 1000).unref();

/**
 * Catat satu langkah ke timeline sebuah order, supaya bisa ditampilkan live
 * di halaman /create_order (poll ke /order/:state) tanpa perlu buka log server.
 */
function pushEvent(record, label, extra = {}) {
  const event = { ts: new Date().toISOString(), label, ...extra };
  record.events.push(event);
  console.log(`[order ${record.state}] ${label}`, extra);
  return event;
}

// Tampilkan cuma sebagian string sensitif (authCode dll) di timeline/log,
// biar nggak nge-expose token utuh ke halaman publik /order/:state.
function mask(value) {
  if (!value) return value;
  const s = String(value);
  return s.length <= 8 ? '*'.repeat(s.length) : `${s.slice(0, 4)}...${s.slice(-4)}`;
}

/**
 * Bikin satu sesi order seamless binding: generate `bindingUrl` (deeplink) +
 * simpan state-nya di pendingBindings. Dipakai bareng oleh /binding/start
 * (query param, buat integrasi lain) dan POST /create_order (form publik).
 */
function createOrderSession({ mobileNumber, amount, orderTitle, productCode, mcc }) {
  if (!widgetApi) {
    const err = new Error('DANA client belum terkonfigurasi (cek .env)');
    err.statusCode = 503;
    throw err;
  }
  if (!mobileNumber) {
    const err = new Error('mobileNumber wajib diisi (query param, field form, atau SEAMLESS_MOBILE_NUMBER di .env)');
    err.statusCode = 400;
    throw err;
  }

  const state = randomUUID();
  const externalId = randomUUID();
  const deviceId = randomUUID();

  const oauthUrlData = {
    externalId,
    merchantId: process.env.MERCHANT_ID,
    redirectUrl: PUBLIC_BASE_URL,
    mode: Oauth2UrlDataModeEnum.Deeplink,
    state,
    seamlessData: {
      mobileNumber,
      verifiedTime: getNowJakarta(),
      deviceId,
      skipRegisterConsult: true,
    },
  };

  const bindingUrl = WidgetUtils.generateOauthUrl(oauthUrlData, privateKey);

  const record = {
    state,
    status: 'pending',
    mobileNumber,
    deviceId,
    externalId,
    amount: amount ? String(amount) : '10000.00',
    orderTitle: (orderTitle && String(orderTitle).trim()) || 'Pesanan via create_order',
    productCode: (productCode && String(productCode).trim()) || process.env.PRODUCT_CODE || '51051000100000000001',
    mcc: (mcc && String(mcc).trim()) || process.env.MCC || '5411',
    bindingUrl,
    createdAt: Date.now(),
    events: [],
  };
  pushEvent(record, 'Order dibuat, menunggu link binding dibuka di HP', { bindingUrl });

  pendingBindings.set(state, record);
  return record;
}

/**
 * 1) Endpoint khusus buat TRIGGER seamless binding lewat query param.
 *    Panggil ini (dari app/backend kamu sendiri, bukan dari user langsung)
 *    dengan ?mobileNumber=628xxxx, nanti dibalikin `bindingUrl` yang harus
 *    dibuka lewat OS-native browser/intent (bukan WebView biasa) supaya
 *    DANA App otomatis kebuka (deeplink) buat consent binding.
 *
 *    Contoh: GET /binding/start?mobileNumber=6287882118259&amount=10000
 *
 *    Untuk pemakaian manual sehari-hari, form GET /create_order (dengan QR
 *    code + live timeline) lebih enak dipakai daripada endpoint ini.
 */
app.get('/binding/start', async (req, res) => {
  try {
    const record = createOrderSession({
      mobileNumber: req.query.mobileNumber || process.env.SEAMLESS_MOBILE_NUMBER,
      amount: req.query.amount,
    });
    console.log(`[binding/start] state=${record.state} mobileNumber=${record.mobileNumber} -> ${record.bindingUrl}`);
    res.json({ ok: true, state: record.state, bindingUrl: record.bindingUrl, resultUrl: `${PUBLIC_BASE_URL}/order/${record.state}` });
  } catch (err) {
    console.error('[binding/start] gagal generate binding URL:', err);
    res.status(err.statusCode || 500).json({ ok: false, message: err.message || String(err) });
  }
});

/**
 * 2) Cek status binding yang sedang/sudah diproses (buat dipoll dari sisi
 *    caller kalau nggak mau mengandalkan redirect browser user).
 *    Dipertahankan sebagai alias lama; /order/:state adalah bentuk barunya
 *    (dipakai halaman /create_order).
 */
app.get('/binding/result', (req, res) => {
  const { state } = req.query;
  const record = state && pendingBindings.get(state);
  if (!record) {
    return res.status(404).json({ ok: false, message: 'state tidak ditemukan / sudah kadaluarsa' });
  }
  res.json({ ok: true, state, ...record });
});

/**
 * 2b) GET /create_order -- halaman form publik (tanpa login) buat bikin
 *     order seamless binding: isi nomor HP + nominal, submit, langsung
 *     dapat bindingUrl + QR code buat di-scan di HP, dan timeline live di
 *     bawahnya (poll ke GET /order/:state) sampai pembayaran selesai.
 *     CATATAN: halaman ini publik -- siapa pun yang tahu URL-nya bisa bikin
 *     order sandbox. Cukup aman untuk pemakaian pribadi, jangan disebar
 *     kalau tidak mau orang lain iseng bikin order.
 */
app.get('/create_order', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'create_order.html'));
});

/**
 * 2c) POST /create_order -- versi form dari /binding/start: terima body
 *     JSON {mobileNumber, amount, orderTitle?, productCode?, mcc?}, balikin
 *     bindingUrl + qrDataUrl (PNG base64, di-generate di server pakai
 *     package `qrcode`, jadi nggak perlu CDN eksternal) + statusUrl buat
 *     dipoll halaman depan.
 */
app.post('/create_order', async (req, res) => {
  try {
    const { mobileNumber, amount, orderTitle, productCode, mcc } = req.body || {};
    const record = createOrderSession({ mobileNumber, amount, orderTitle, productCode, mcc });
    const qrDataUrl = await qrcode.toDataURL(record.bindingUrl, { margin: 1, width: 260 });
    res.json({
      ok: true,
      state: record.state,
      bindingUrl: record.bindingUrl,
      qrDataUrl,
      statusUrl: `/order/${record.state}`,
    });
  } catch (err) {
    console.error('[create_order] gagal buat order:', err);
    res.status(err.statusCode || 500).json({ ok: false, message: err.message || String(err) });
  }
});

/**
 * 2d) GET /order/:state -- endpoint polling JSON buat halaman /create_order:
 *     status terkini + seluruh timeline event (dibuat, authCode masuk, token
 *     ditukar, order dibuat, redirect ke pembayaran, notifikasi masuk, dst).
 */
app.get('/order/:state', (req, res) => {
  const record = pendingBindings.get(req.params.state);
  if (!record) {
    return res.status(404).json({ ok: false, message: 'Order tidak ditemukan / sudah kadaluarsa (TTL 30 menit)' });
  }
  res.json({ ok: true, ...record });
});

/**
 * 3) Callback yang beneran dipanggil DANA (browser user di-redirect ke sini
 *    setelah consent binding), bawa query param auth_code/authCode + state.
 *    Begitu diterima, langsung lanjut otomatis: applyToken -> buat order ->
 *    applyOTT -> redirect user ke halaman pembayaran final. Tidak ada lagi
 *    langkah copy-paste manual.
 *
 *    Dipasang di root ("/") karena itu yang terdaftar sebagai Finish Redirect
 *    URL di dashboard DANA. "/oauth/callback" tetap disediakan sebagai alias
 *    kalau suatu saat redirect URL-nya didaftarkan pakai sub-path itu.
 */
async function handleOauthCallback(req, res) {
  saveIncoming('oauth_callback', req);

  const authCode = req.query.authCode || req.query.auth_code;
  const { state } = req.query;

  if (!authCode || !state) {
    // Bukan callback binding (mis. cuma health check GET biasa) -> jangan
    // diproses, cukup jawab OK supaya nggak 404.
    return res.status(200).json({ ok: true, message: 'dana-webhook aktif' });
  }

  const pending = pendingBindings.get(state);
  if (!pending) {
    console.warn(`[oauth-callback] state tidak dikenal/kadaluarsa: ${state}`);
    return res.status(400).send('State tidak dikenal atau sudah kadaluarsa. Mulai ulang lewat /binding/start.');
  }

  pending.status = 'processing';
  pushEvent(pending, 'Callback diterima dari DANA (authCode masuk)', { authCode: mask(authCode) });
  console.log(`[oauth-callback] state=${state} authCode diterima, lanjut applyToken...`);

  try {
    // 3a. Tukar auth_code -> accessToken
    const tokenResponse = await widgetApi.applyToken({
      grantType: ApplyTokenAuthorizationCodeRequestGrantTypeEnum.AuthorizationCode,
      authCode,
    });
    pushEvent(pending, 'Token berhasil ditukar (accessToken didapat)');

    // 3b. Buat order pembayaran
    const partnerReferenceNo = randomUUID();
    const paymentResponse = await widgetApi.widgetPayment({
      partnerReferenceNo,
      merchantId: process.env.MERCHANT_ID,
      amount: { value: pending.amount, currency: 'IDR' },
      validUpTo: getValidUpTo(25),
      additionalInfo: {
        productCode: pending.productCode || process.env.PRODUCT_CODE || '51051000100000000001',
        mcc: pending.mcc || process.env.MCC || '5411',
        order: { orderTitle: pending.orderTitle || 'Seamless Binding Payment' },
        envInfo: { terminalType: EnvInfoTerminalTypeEnum.Web },
      },
      urlParams: [
        { url: `${PUBLIC_BASE_URL}/status`, type: UrlParamTypeEnum.PayReturn, isDeeplink: 'N' },
        { url: `${PUBLIC_BASE_URL}/notification`, type: UrlParamTypeEnum.Notification, isDeeplink: 'N' },
      ],
    });
    pending.partnerReferenceNo = partnerReferenceNo;
    partnerRefIndex.set(partnerReferenceNo, state);
    pushEvent(pending, 'Order pembayaran dibuat di DANA', { partnerReferenceNo });

    // 3c. Minta One-Time-Token pakai accessToken hasil binding
    const ottResponse = await widgetApi.applyOTT({
      userResources: [ApplyOTTRequestUserResourcesEnum.Ott],
      additionalInfo: {
        accessToken: tokenResponse.accessToken,
        deviceId: pending.deviceId,
      },
    });
    pushEvent(pending, 'One-Time-Token (OTT) diperoleh, menyiapkan link pembayaran final');

    // 3d. Gabungkan webRedirectUrl + ott -> URL final, user tinggal
    //     diarahkan ke sini, pembayaran otomatis selesai (sudah login).
    const completePaymentUrl = WidgetUtils.generateCompletePaymentUrl(paymentResponse, ottResponse);

    pending.status = 'done';
    pending.completePaymentUrl = completePaymentUrl;
    pushEvent(pending, 'Redirect otomatis ke halaman pembayaran DANA', { completePaymentUrl });

    console.log(`[oauth-callback] state=${state} sukses -> redirect ke ${completePaymentUrl}`);
    return res.redirect(302, completePaymentUrl);
  } catch (err) {
    pending.status = 'error';
    pending.error = err?.errorMessage || err.message || String(err);
    pushEvent(pending, 'Gagal memproses binding/pembayaran', { error: pending.error });
    console.error(`[oauth-callback] state=${state} gagal:`, err);
    return res.status(500).send('Gagal menyelesaikan proses binding. Cek log server / GET /order/' + state);
  }
}

app.get('/', handleOauthCallback);
app.all('/oauth/callback', handleOauthCallback);

/**
 * Cari record order lewat originalPartnerReferenceNo yang dikirim balik oleh
 * DANA di /status maupun /notification (keduanya cuma tahu partnerReferenceNo,
 * bukan `state`).
 */
function findOrderByPartnerRef(partnerReferenceNo) {
  if (!partnerReferenceNo) return null;
  const orderState = partnerRefIndex.get(partnerReferenceNo);
  return orderState ? pendingBindings.get(orderState) : null;
}

// Halaman kecil buat manusia (browser HP user), bukan buat mesin -- makanya
// HTML, bukan JSON. Dipakai buat "Finish Payment URL"/PayReturn (lihat di
// bawah kenapa itu bukan endpoint notifikasi server-to-server).
function renderStatusPage({ status, orderState }) {
  const statusStr = String(status || 'UNKNOWN');
  const isSuccess = statusStr === '00' || statusStr.toUpperCase() === 'SUCCESS';
  const isCancelled = statusStr === '05';
  const color = isSuccess ? '#16a34a' : isCancelled ? '#d97706' : '#dc2626';
  const title = isSuccess ? 'Pembayaran Berhasil' : isCancelled ? 'Dibatalkan / Kedaluwarsa' : `Status: ${statusStr}`;
  const backLink = orderState ? `/create_order?ref=${encodeURIComponent(orderState)}` : '/create_order';
  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Status Pembayaran</title>
<style>
  body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#f8fafc;display:flex;min-height:100vh;
       align-items:center;justify-content:center;margin:0;color:#1e293b}
  .card{background:#fff;padding:32px;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:360px;
        text-align:center}
  .badge{display:inline-block;padding:6px 14px;border-radius:999px;background:${color}1a;color:${color};
         font-weight:600;font-size:14px}
  h1{font-size:20px;margin:16px 0 8px;color:${color}}
  p{color:#64748b;font-size:14px;line-height:1.5}
  a.btn{display:inline-block;margin-top:16px;padding:10px 18px;background:#2563eb;color:#fff;border-radius:8px;
        text-decoration:none;font-size:14px;font-weight:600}
</style></head>
<body>
  <div class="card">
    <div class="badge">${isSuccess ? '✓ Berhasil' : '⚠ ' + statusStr}</div>
    <h1>${title}</h1>
    <p>Halaman ini muncul karena DANA mengalihkan browsermu balik ke merchant setelah checkout selesai.
       Kamu bisa menutup tab ini, atau lihat detail lengkap di halaman order.</p>
    <a class="btn" href="${backLink}">Kembali ke Halaman Order</a>
  </div>
</body></html>`;
}

/**
 * "Finish Payment URL" / PayReturn -- BUKAN webhook server-to-server. Ini
 * halaman yang dibuka di BROWSER HP USER sendiri (redirect biasa, umumnya
 * GET) begitu dia selesai checkout di halaman DANA, bawa query param
 * originalPartnerReferenceNo/originalReferenceNo/merchantId/status (lihat
 * urlParams.type=PayReturn di widgetPayment). Yang notifikasi server-to-
 * server beneran itu /notification di bawah.
 */
app.get('/status', (req, res) => {
  const filePath = saveIncoming('webhook2', req);
  const { originalPartnerReferenceNo, status } = req.query;
  const order = findOrderByPartnerRef(originalPartnerReferenceNo);
  if (order) {
    pushEvent(order, 'Kembali dari halaman checkout DANA (Finish Payment redirect)', {
      status,
      originalPartnerReferenceNo,
    });
  }
  console.log(`[status] GET ${req.originalUrl} -> ${filePath}`, req.query);
  res.status(200).send(renderStatusPage({ status, orderState: order?.state }));
});
// Method lain di /status (jaga-jaga) -- tetap disimpan & di-ack seperti sebelumnya.
app.all('/status', handleWebhook('webhook2'));

/**
 * "Finish Payment" Notify -- panggilan ASLI server-to-server dari DANA
 * (tanpa browser user terlibat) buat ngasih tau hasil akhir transaksi.
 * Body-nya sesuai kontrak FinishNotifyRequest; balasannya WAJIB berbentuk
 * FinishNotifyResponse {responseCode, responseMessage}, bukan {ok, message}
 * generik seperti sebelumnya.
 */
app.post('/notification', (req, res) => {
  const filePath = saveIncoming('webhook1', req);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { originalPartnerReferenceNo, latestTransactionStatus } = body;
  const order = findOrderByPartnerRef(originalPartnerReferenceNo);
  if (order) {
    if (latestTransactionStatus === '00') order.status = 'paid';
    pushEvent(order, 'Notifikasi hasil pembayaran diterima dari DANA (server-to-server)', {
      status: latestTransactionStatus,
      originalPartnerReferenceNo,
    });
  }
  console.log(`[notification] POST ${req.originalUrl} -> ${filePath}`, body);
  // NOTE: belum verifikasi X-SIGNATURE (WebhookParser dari dana-node/webhook/v1)
  // -- aman buat sandbox/personal use, tapi tambahkan sebelum dipakai di
  // production supaya notifikasi palsu tidak ikut mengubah status order.
  res.status(200).json({ responseCode: '2005500', responseMessage: 'Successful' });
});
// Method lain di /notification (jaga-jaga) -- tetap disimpan & di-ack seperti sebelumnya.
app.all('/notification', handleWebhook('webhook1'));

// Tangkap semua request lain di luar path-path di atas (path lain atau
// method lain) supaya tetap tersimpan dan tercetak di log, bukan cuma 404
// diam-diam.
app.all(/.*/, handleWebhook('lainnya'));

app.listen(PORT, () => {
  console.log(`Server jalan di http://localhost:${PORT}`);
  console.log(`- GET  http://localhost:${PORT}/create_order              (form publik + QR + live status)`);
  console.log(`- GET  http://localhost:${PORT}/order/:state              (polling JSON buat halaman di atas)`);
  console.log(`- GET  http://localhost:${PORT}/binding/start?mobileNumber=628xxxxxxxxx`);
  console.log(`- GET  http://localhost:${PORT}/binding/result?state=...  (alias lama dari /order/:state)`);
  console.log(`- ANY  http://localhost:${PORT}/  (dipanggil DANA sbg Finish Redirect URL)`);
  console.log(`- GET  http://localhost:${PORT}/status                    (Finish Payment / PayReturn, browser user)`);
  console.log(`- POST http://localhost:${PORT}/notification              (Finish Notify, server-to-server)`);
});
