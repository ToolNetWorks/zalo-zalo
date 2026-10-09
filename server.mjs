import http from "node:http";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { Zalo, ThreadType, LoginQRCallbackEventType as Event } from "zca-js";

const HOST = "127.0.0.1";
const PORT = 9093;

let state = { status: "IDLE", qrImage: null };
let active = false;
let retryQR = null;
let api = null;
// RECOVERY_DASHBOARD_V1: dữ liệu thật, chỉ phục vụ chủ tài khoản đã xác thực.
const ADMIN_PASSWORD = (await fs.readFile(new URL('./.run/admin-password', import.meta.url), 'utf8')).trim();
let profilePromise = null;
let contactsPromise = null;
function authenticatedRequest(req) {
  const value = req.headers.authorization || '';
  if (!value.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(value.slice(6), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0 || decoded.slice(0, colon) !== 'admin') return false;
    const actual = Buffer.from(decoded.slice(colon + 1));
    const expected = Buffer.from(ADMIN_PASSWORD);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}
function safeAvatar(value) {
  return typeof value === 'string' && /^https:\/\//.test(value) ? value : '';
}
function safeUser(user = {}) {
  return {
    id: String(user.userId || user.uid || ''),
    name: String(user.displayName || user.zaloName || user.username || 'Không có tên'),
    zaloName: String(user.zaloName || ''),
    username: String(user.username || ''),
    phone: String(user.phoneNumber || ''),
    avatar: safeAvatar(user.avatar)
  };
}
async function getProfile() {
  if (!profilePromise) {
    profilePromise = api.fetchAccountInfo()
      .then(data => safeUser(data?.profile))
      .catch(error => { profilePromise = null; throw error; });
  }
  return profilePromise;
}
async function getContacts() {
  if (!contactsPromise) {
    contactsPromise = api.getAllFriends()
      .then(data => {
        if (!Array.isArray(data)) throw new Error('Unexpected contacts response');
        return data.map(safeUser).filter(item => item.id);
      })
      .catch(error => { contactsPromise = null; throw error; });
  }
  return contactsPromise;
}


// RECOVERY_ACTIVITY_V1 — Aggregate activity only; NEVER store message text.
const activityFile = new URL('./.run/zalo-contact-activity.json', import.meta.url);
const DAY = 86400000;
const WINDOW_MS = 30 * DAY;
const MAX_EVENTS = 30000;
let activityOwner = '';
let activityState = 'NOT_STARTED';
let activityError = '';
let activityLastSync = null;
let activityEvents = new Map();
let activityListenerStarted = false;
let activitySaveTimer = null;
let activityWriteQueue = Promise.resolve();

try {
  const saved = JSON.parse(await fs.readFile(activityFile, 'utf8'));
  activityOwner = typeof saved.owner === 'string' ? saved.owner : '';
  const cut = Date.now() - WINDOW_MS;
  if (Array.isArray(saved.events)) {
    for (const item of saved.events.slice(-MAX_EVENTS)) {
      if (typeof item.key !== 'string' || !/^[a-f0-9]{64}$/.test(item.key)) continue;
      if (typeof item.uid !== 'string' || item.uid.length > 100) continue;
      if (!Number.isFinite(item.ts) || item.ts < cut || item.ts > Date.now() + DAY) continue;
      activityEvents.set(item.key, { uid: item.uid, ts: item.ts });
    }
  }
  activityLastSync = Number.isFinite(saved.lastSync) ? saved.lastSync : null;
} catch (error) {
  if (error.code !== 'ENOENT') console.error('Activity metadata could not be read');
}

function activityTrim() {
  const cut = Date.now() - WINDOW_MS;
  for (const [key, row] of activityEvents) if (row.ts < cut) activityEvents.delete(key);
  while (activityEvents.size > MAX_EVENTS) activityEvents.delete(activityEvents.keys().next().value);
}
function activitySaveSoon() {
  if (activitySaveTimer) return;
  activitySaveTimer = setTimeout(() => {
    activitySaveTimer = null;
    activityTrim();
    const payload = JSON.stringify({
      version: 1,
      owner: activityOwner,
      lastSync: activityLastSync,
      events: [...activityEvents].map(([key,row]) => ({key, ...row}))
    });
    activityWriteQueue = activityWriteQueue.then(async () => {
      const tmp = new URL('./.run/zalo-contact-activity.json.tmp', import.meta.url);
      await fs.writeFile(tmp, payload, {mode:0o600});
      await fs.rename(tmp, activityFile);
    }).catch(() => console.error('Cannot save activity metadata'));
  }, 1000);
}
async function activityCheckOwner() {
  const profile = await getProfile();
  if (!profile.id) throw new Error('Zalo profile ID unavailable');
  if (activityOwner !== profile.id) {
    activityOwner = profile.id;
    activityEvents.clear();
    activityLastSync = null;
    activityState = 'NOT_STARTED';
    activitySaveSoon();
  }
}
function activityAddMessage(message) {
  if (!message || !message.data) return;
  const uid = String(message.threadId || '');
  const msg = message.data;
  const msgId = String(msg.realMsgId || msg.msgId || msg.cliMsgId || '');
  let ts = Number(msg.ts);
  if (ts > 0 && ts < 1e11) ts *= 1000;
  if (!uid || uid.length > 100 || !msgId || msgId.length > 150) return;
  if (!Number.isFinite(ts) || ts < Date.now()-WINDOW_MS || ts > Date.now()+DAY) return;
  const key = crypto.createHash('sha256').update(uid+'|'+msgId).digest('hex');
  if (activityEvents.has(key)) return;
  activityEvents.set(key, { uid, ts });
  activityTrim();
  activitySaveSoon();
}

function activityStartListener() {
  if (!api || activityListenerStarted) return;
  activityListenerStarted = true;
  activityState = 'CONNECTING';
  activityError = '';
  let historyReceived = false;
  const listener = api.listener;
  listener.on('message', msg => {
    if (msg?.type === ThreadType.User) activityAddMessage(msg);
  });
  listener.on('old_messages', (messages, type) => {
    if (type !== ThreadType.User || !Array.isArray(messages)) return;
    historyReceived = true;
    for (const msg of messages.slice(0, 30000)) activityAddMessage(msg);
    activityLastSync = Date.now();
    activityState = 'READY';
    activitySaveSoon();
  });
  listener.on('cipher_key', () => {
    activityState = 'SYNCING';
    try { listener.requestOldMessages(ThreadType.User); }
    catch (e) {activityState='LIVE_ONLY'; activityError='Không truy vấn được lịch sử';}
    setTimeout(() => {
      if (!historyReceived && activityState === 'SYNCING') {
        activityState = 'LIVE_ONLY';
        activityError = 'Không nhận được lịch sử; chỉ thống kê tin mới khi đang kết nối';
      }
    }, 25000);
  });
  listener.on('error', () => {
    activityState = 'ERROR';
    activityError = 'Kết nối đồng bộ gặp lỗi';
  });
  listener.on('closed', () => {
    activityState = 'DISCONNECTED';
    activityError = 'Kết nối Zalo đã đóng; dữ liệu đã ghi nhận vẫn được giữ';
    activityListenerStarted = false;
  });
  try { listener.start(); }
  catch (e) {
    activityListenerStarted = false;
    activityState = 'ERROR';
    activityError = 'Không thể bắt đầu đồng bộ';
  }
}
async function activitySummary() {
  await activityCheckOwner();
  const contacts = await getContacts();
  activityTrim();
  const scores = new Map();
  for (const item of activityEvents.values()) {
    const row = scores.get(item.uid) || {count:0,last:0};
    row.count++;
    row.last = Math.max(row.last, item.ts);
    scores.set(item.uid,row);
  }
  return {
    status: activityState,
    error: activityError,
    sampledMessages: activityEvents.size,
    lastSync: activityLastSync,
    windowDays: 30,
    contacts: contacts.map(x => {
      const s=scores.get(x.id) || {count:0,last:0};
      return {id:x.id, name:x.name, avatar:x.avatar, count:s.count, last:s.last};
    }).filter(x => x.count > 0).sort((a,b)=>b.count-a.count || b.last-a.last).slice(0,10)
  };
}

function update(status, qrImage = null) {
  state = { status, qrImage };
}

function startLogin() {
  if (api) return;

  if (active) {
    if (
      retryQR &&
      ["QR_EXPIRED", "QR_DECLINED"].includes(state.status)
    ) {
      const retry = retryQR;
      retryQR = null;
      update("QR_PENDING");
      retry();
    }
    return;
  }

  active = true;
  update("QR_PENDING");

  const zalo = new Zalo({ logging: false });

  zalo.loginQR({}, (event) => {
    switch (event.type) {
      case Event.QRCodeGenerated: {
        const image = event.data?.image || "";
        if (
          image.length > 500000 ||
          !/^[A-Za-z0-9+/=]+$/.test(image)
        ) {
          update("AUTH_FAILED");
          event.actions.abort();
          return;
        }
        retryQR = null;
        update("QR_READY", "data:image/png;base64," + image);
        break;
      }

      case Event.QRCodeScanned:
        update("QR_SCANNED");
        break;

      case Event.QRCodeExpired:
        retryQR = event.actions.retry;
        update("QR_EXPIRED");
        break;

      case Event.QRCodeDeclined:
        retryQR = event.actions.retry;
        update("QR_DECLINED");
        break;

      case Event.GotLoginInfo:
        // Tuyệt đối không đưa cookie/token ra frontend.
        update("WAITING_CONFIRMATION");
        break;
    }
  })
  .then(result => {
    api = result;
    profilePromise = null;
    contactsPromise = null;
    update("AUTHENTICATED");
  })
  .catch(error => {
    console.error("QR login failed:", error?.name || "Error");
    update("AUTH_FAILED");
  })
  .finally(() => {
    active = false;
    retryQR = null;
  });
}

const html = await fs.readFile(
  new URL("./public/index.html", import.meta.url)
);
const client = await fs.readFile(
  new URL("./public/qr-client.js", import.meta.url)
);

function sendJSON(res, code, data) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(data));
}

http.createServer((req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (!authenticatedRequest(req)) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Recovery Center", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8'
    });
    return res.end('Yêu cầu đăng nhập quản trị');
  }

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8"
    });
    return res.end(html);
  }

  if (req.method === "GET" && req.url === "/qr-client.js") {
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8"
    });
    return res.end(client);
  }

  if (req.method === "GET" && req.url === "/api/health") {
    return sendJSON(res, 200, {
      ok: true,
      service: "zalo-qr-recovery",
      version: "0.2.0"
    });
  }


  if (req.method === 'GET' && req.url === '/api/zalo/frequent') {
    if (!api) return sendJSON(res, 401, { error: 'ZALO_NOT_AUTHENTICATED' });
    activitySummary().then(data => sendJSON(res, 200, data))
      .catch(() => sendJSON(res, 502, {error:'FREQUENT_CONTACTS_UNAVAILABLE'}));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/zalo/frequent/sync') {
    if (!api) return sendJSON(res, 401, {error:'ZALO_NOT_AUTHENTICATED'});
    const origin = req.headers.origin;
    const goodOrigin = !origin || (()=>{
      try {return new URL(origin).host === req.headers.host;}catch{return false;}
    })();
    if (!goodOrigin || req.headers['sec-fetch-site'] === 'cross-site' ||
        (req.headers['content-type']||'').split(';')[0] !== 'application/json') {
      return sendJSON(res, 403, {error:'FORBIDDEN'});
    }
    activityCheckOwner()
      .then(() => {activityStartListener();sendJSON(res, 202, {status:activityState});})
      .catch(() => sendJSON(res, 502, {error:'ACTIVITY_SYNC_FAILED'}));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/zalo/profile') {
    if (!api) return sendJSON(res, 401, { error: 'ZALO_NOT_AUTHENTICATED' });
    getProfile().then(profile => sendJSON(res, 200, { profile }))
      .catch(error => {
        console.error('Profile fetch failed:', error?.message);
        sendJSON(res, 502, { error: 'PROFILE_FETCH_FAILED' });
      });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/zalo/contacts') {
    if (!api) return sendJSON(res, 401, { error: 'ZALO_NOT_AUTHENTICATED' });
    getContacts().then(contacts => sendJSON(res, 200, { total: contacts.length, contacts }))
      .catch(error => {
        console.error('Contacts fetch failed:', error?.message);
        sendJSON(res, 502, { error: 'CONTACTS_FETCH_FAILED' });
      });
    return;
  }

  if (req.method === "GET" && req.url === "/api/qr/status") {
    return sendJSON(res, 200, {
      status: state.status,
      authenticated: Boolean(api),
      qrImage: state.qrImage
    });
  }

  if (req.method === "POST" && req.url === "/api/qr/start") {
    // Chặn yêu cầu khởi tạo QR từ website khác.
    if (
      req.headers["sec-fetch-site"] === "cross-site" ||
      req.headers["content-type"]?.split(";")[0] !==
        "application/json"
    ) {
      return sendJSON(res, 403, { error: "Forbidden" });
    }

    if (req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.headers.host) {
          return sendJSON(res, 403, { error: "Forbidden" });
        }
      } catch {
        return sendJSON(res, 403, { error: "Forbidden" });
      }
    }

    startLogin();
    return sendJSON(res, 202, {
      status: state.status
    });
  }

  return sendJSON(res, 404, { error: "Not found" });
}).listen(PORT, HOST, () => {
  console.log(`Zalo QR Recovery running at http://${HOST}:${PORT}`);
});
