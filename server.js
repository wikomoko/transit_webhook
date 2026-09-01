// quiet: true -- dotenv v17 by default prints a random self-promo "tip" line
// to stdout after loading; itu bukan bug, tapi kita matikan biar log server
// tetap bersih cuma isi log request beneran.
require('dotenv').config({ quiet: true });

const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

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
const PENDING_TTL_MS = 30 * 60 * 1000; // 30 menit, sejalan sama batas validUpTo sandbox

setInterval(() => {
  const now = Date.now();
  for (const [state, record] of pendingBindings) {
    if (now - record.createdAt > PENDING_TTL_MS) {
      pendingBindings.delete(state);
    }
  }
}, 5 * 60 * 1000).unref();

/**
 * 1) Endpoint khusus buat TRIGGER seamless binding.
 *    Panggil ini (dari app/backend kamu sendiri, bukan dari user langsung)
 *    dengan ?mobileNumber=628xxxx, nanti dibalikin `bindingUrl` yang harus
 *    dibuka lewat OS-native browser/intent (bukan WebView biasa) supaya
 *    DANA App otomatis kebuka (deeplink) buat consent binding.
 *
 *    Contoh: GET /binding/start?mobileNumber=6287882118259&amount=10000
 */
app.get('/binding/start', async (req, res) => {
  if (!widgetApi) {
    return res.status(503).json({ ok: false, message: 'DANA client belum terkonfigurasi (cek .env)' });
  }

  const mobileNumber = req.query.mobileNumber || process.env.SEAMLESS_MOBILE_NUMBER;
  if (!mobileNumber) {
    return res.status(400).json({ ok: false, message: 'mobileNumber wajib diisi (query param atau SEAMLESS_MOBILE_NUMBER di .env)' });
  }
  const amount = req.query.amount ? String(req.query.amount) : '10000.00';

  try {
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

    pendingBindings.set(state, {
      status: 'pending',
      mobileNumber,
      deviceId,
      externalId,
      amount,
      createdAt: Date.now(),
    });

    console.log(`[binding/start] state=${state} mobileNumber=${mobileNumber} -> ${bindingUrl}`);

    res.json({ ok: true, state, bindingUrl, resultUrl: `${PUBLIC_BASE_URL}/binding/result?state=${state}` });
  } catch (err) {
    console.error('[binding/start] gagal generate binding URL:', err);
    res.status(500).json({ ok: false, message: err.message || String(err) });
  }
});

/**
 * 2) Cek status binding yang sedang/sudah diproses (buat dipoll dari sisi
 *    caller kalau nggak mau mengandalkan redirect browser user).
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
  console.log(`[oauth-callback] state=${state} authCode diterima, lanjut applyToken...`);

  try {
    // 3a. Tukar auth_code -> accessToken
    const tokenResponse = await widgetApi.applyToken({
      grantType: ApplyTokenAuthorizationCodeRequestGrantTypeEnum.AuthorizationCode,
      authCode,
    });

    // 3b. Buat order pembayaran
    const partnerReferenceNo = randomUUID();
    const paymentResponse = await widgetApi.widgetPayment({
      partnerReferenceNo,
      merchantId: process.env.MERCHANT_ID,
      amount: { value: pending.amount, currency: 'IDR' },
      validUpTo: getValidUpTo(25),
      additionalInfo: {
        productCode: process.env.PRODUCT_CODE || '51051000100000000001',
        mcc: process.env.MCC || '5411',
        order: { orderTitle: 'Seamless Binding Payment' },
        envInfo: { terminalType: EnvInfoTerminalTypeEnum.Web },
      },
      urlParams: [
        { url: `${PUBLIC_BASE_URL}/status`, type: UrlParamTypeEnum.PayReturn, isDeeplink: 'N' },
        { url: `${PUBLIC_BASE_URL}/notification`, type: UrlParamTypeEnum.Notification, isDeeplink: 'N' },
      ],
    });

    // 3c. Minta One-Time-Token pakai accessToken hasil binding
    const ottResponse = await widgetApi.applyOTT({
      userResources: [ApplyOTTRequestUserResourcesEnum.Ott],
      additionalInfo: {
        accessToken: tokenResponse.accessToken,
        deviceId: pending.deviceId,
      },
    });

    // 3d. Gabungkan webRedirectUrl + ott -> URL final, user tinggal
    //     diarahkan ke sini, pembayaran otomatis selesai (sudah login).
    const completePaymentUrl = WidgetUtils.generateCompletePaymentUrl(paymentResponse, ottResponse);

    pending.status = 'done';
    pending.partnerReferenceNo = partnerReferenceNo;
    pending.completePaymentUrl = completePaymentUrl;

    console.log(`[oauth-callback] state=${state} sukses -> redirect ke ${completePaymentUrl}`);
    return res.redirect(302, completePaymentUrl);
  } catch (err) {
    pending.status = 'error';
    pending.error = err?.errorMessage || err.message || String(err);
    console.error(`[oauth-callback] state=${state} gagal:`, err);
    return res.status(500).send('Gagal menyelesaikan proses binding. Cek log server / GET /binding/result?state=' + state);
  }
}

app.get('/', handleOauthCallback);
app.all('/oauth/callback', handleOauthCallback);

// Endpoint mandatory DANA lainnya (Finish Payment Notify, Disburse to Bank
// Notify) -- masih sekadar log & simpan payload seperti sebelumnya.
app.all('/notification', handleWebhook('webhook1'));
app.all('/status', handleWebhook('webhook2'));

// Tangkap semua request lain di luar path-path di atas (path lain atau
// method lain) supaya tetap tersimpan dan tercetak di log, bukan cuma 404
// diam-diam.
app.all(/.*/, handleWebhook('lainnya'));

app.listen(PORT, () => {
  console.log(`Server jalan di http://localhost:${PORT}`);
  console.log(`- GET  http://localhost:${PORT}/binding/start?mobileNumber=628xxxxxxxxx`);
  console.log(`- GET  http://localhost:${PORT}/binding/result?state=...`);
  console.log(`- ANY  http://localhost:${PORT}/  (dipanggil DANA sbg Finish Redirect URL)`);
  console.log(`- POST http://localhost:${PORT}/notification`);
  console.log(`- POST http://localhost:${PORT}/status`);
});
