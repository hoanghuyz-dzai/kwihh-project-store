// Kwihh Project - zero-dependency server (Node >= 22.5: node:http, node:sqlite, node:crypto)
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// Load .env automatically so `node server.js` uses the configured admin account.
try {
  if (typeof process.loadEnvFile === 'function') process.loadEnvFile(path.join(__dirname, '.env'));
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('[env] Could not load .env:', e.message);
}
const PORT = +process.env.PORT || 3000, ROOT = __dirname;
const db = new DatabaseSync(path.join(ROOT, process.env.DB_FILE || 'data/kwihh.db'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, username TEXT UNIQUE NOT NULL COLLATE NOCASE, password_hash TEXT NOT NULL, birth_date TEXT, balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0), role TEXT NOT NULL DEFAULT 'user', locked INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS services(id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, description TEXT, price INTEGER NOT NULL CHECK(price>=0), file TEXT, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), service_id INTEGER NOT NULL REFERENCES services(id), service_name TEXT, price INTEGER NOT NULL, file TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS recharge_requests(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), provider TEXT, amount INTEGER NOT NULL, serial TEXT, card_code TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP, processed_at TEXT);
CREATE TABLE IF NOT EXISTS transactions(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, admin_id INTEGER, amount INTEGER NOT NULL, type TEXT NOT NULL, reason TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);

// ---------- helpers ----------
const hash = pw => { const s = crypto.randomBytes(16); return 's$' + s.toString('hex') + '$' + crypto.scryptSync(pw, s, 64).toString('hex'); };
const verify = (pw, h) => { const [, s, k] = h.split('$'); const d = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64); return crypto.timingSafeEqual(d, Buffer.from(k, 'hex')); };
const DUMMY = hash('dummy-password'); // equalises timing for unknown usernames
const sessions = new Map(), hits = new Map();
const err = (code, message) => Object.assign(new Error(message), { code });
const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
const str = (v, max = 200) => typeof v === 'string' && v.length <= max ? v.trim() : '';
const moneyString = v => {
  if (v === Infinity || v === 'Infinity') return 'Infinity';
  const s = String(v ?? '').trim();
  if (!/^-?\d+$/.test(s)) return null;
  return s.replace(/^(-?)0+(?=\d)/, '$1') || '0';
};
const toBigIntMoney = v => {
  const s = moneyString(v);
  if (s === 'Infinity') return null;
  return s === null ? null : BigInt(s);
};
const addMoney = (current, delta) => {
  const c = moneyString(current) ?? '0';
  if (c === 'Infinity') return 'Infinity';
  const d = toBigIntMoney(delta);
  if (d === null) throw err(400, 'Số tiền không hợp lệ.');
  const n = BigInt(c) + d;
  if (n < 0n) throw err(400, 'Số dư không thể âm.');
  return n.toString();
};
const pubBalance = v => moneyString(v) === 'Infinity' ? 'Infinity' : (moneyString(v) ?? '0');
const pub = u => u && { id: u.id, username: u.username, email: u.email, balance: pubBalance(u.balance), role: u.role, created_at: u.created_at };
const limited = (key, max, ms) => { const now = Date.now(), h = (hits.get(key) || []).filter(t => now - t < ms); h.push(now); hits.set(key, h); return h.length > max; };
const PROVIDERS = { VIETTEL: [10000, 20000, 50000, 100000, 200000, 500000] };

function seed() {
  const add = (u, e, pw, role, bal) => {
    const existing = db.prepare('SELECT * FROM users WHERE username=?').get(u);
    if (!existing) db.prepare('INSERT INTO users(email,username,password_hash,role,balance) VALUES(?,?,?,?,?)').run(e, u, hash(pw), role, bal);
    return existing;
  };

  // Admin credentials are controlled by .env. On every startup the configured
  // account is created when missing and its password/role/email are kept in sync.
  const adminUsername = (process.env.ADMIN_USERNAME || 'admin').trim();
  const adminPassword = process.env.ADMIN_PASSWORD || 'change-me-strong';
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(adminUsername)) throw new Error('ADMIN_USERNAME must be 3-20 characters: letters, numbers, or _.');
  if (adminPassword.length < 8) throw new Error('ADMIN_PASSWORD must be at least 8 characters.');
  const adminEmail = `${adminUsername}@kwihh.local`;
  const existingAdmin = db.prepare('SELECT * FROM users WHERE username=?').get(adminUsername);
  if (!existingAdmin) {
    db.prepare('INSERT INTO users(email,username,password_hash,role,balance) VALUES(?,?,?,?,?)').run(adminEmail, adminUsername, hash(adminPassword), 'admin', 0);
    console.log(`[seed] created admin account: ${adminUsername}`);
  } else {
    const passwordMatches = verify(adminPassword, existingAdmin.password_hash);
    if (!passwordMatches || existingAdmin.role !== 'admin') {
      db.prepare("UPDATE users SET password_hash=?, role='admin', locked=0, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(hash(adminPassword), existingAdmin.id);
      console.log(`[seed] synchronized admin credentials: ${adminUsername}`);
    }
  }

  add('demo', 'demo@kwihh.local', process.env.DEMO_PASSWORD || 'demo-pass-123', 'user', 20000);
  if (!db.prepare('SELECT 1 FROM services').get()) {
    const ins = db.prepare('INSERT INTO services(name,category,description,price,file) VALUES(?,?,?,?,?)');
    [['BOT ZALO BASIC','BOT','Bot Zalo cơ bản, trả lời tự động','20000','botzalo20k.zip'],['BOT TELEGRAM PRO','BOT','Bot Telegram lệnh + menu + admin','50000','bottelegram50k.zip'],['BOT DISCORD ULTIMATE','BOT','Bot Discord moderation + music','100000','botdiscord100k.zip'],['TOOL THEO YÊU CẦU','TOOL','Tool tự động hóa theo ý bạn','20000','tool20k.zip'],['CHROME EXTENSION','TIỆN ÍCH','Tiện ích trình duyệt tùy biến','30000','extension30k.zip'],['WEBSITE 3D','WEBSITE','Website 3D cao cấp theo ý tưởng','200000','website3d200k.zip']]
      .forEach(s => { ins.run(s[0], s[1], s[2], +s[3], s[4]); const f = path.join(ROOT, 'files/dichvu', s[4]); if (!fs.existsSync(f)) fs.writeFileSync(f, 'Placeholder for ' + s[0] + '. Replace with real product file.\n'); });
  }
}
seed(); if (process.argv.includes('--seed')) process.exit(0);

// ---------- routes ----------
const R = [];
const route = (m, p, auth, fn) => R.push({ m, re: new RegExp('^' + p.replace(/:\w+/g, '(\\d+)') + '$'), auth, fn });
route('POST', '/api/auth/register', 0, ({ body, res }) => {
  const email = str(body.email, 120).toLowerCase(), username = str(body.username, 20), pw = str(body.password, 100), bd = str(body.birth_date, 10);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw err(400, 'Email không hợp lệ.');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) throw err(400, 'Tên tài khoản 3-20 ký tự (chữ, số, _).');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bd) || isNaN(Date.parse(bd))) throw err(400, 'Ngày sinh không hợp lệ.');
  if (pw.length < 8) throw err(400, 'Mật khẩu tối thiểu 8 ký tự.');
  if (pw !== body.confirm) throw err(400, 'Xác nhận mật khẩu không khớp.');
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) throw err(409, 'Tên tài khoản này đã được sử dụng.');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw err(409, 'Email đã được đăng ký.');
  db.prepare('INSERT INTO users(email,username,password_hash,birth_date) VALUES(?,?,?,?)').run(email, username, hash(pw), bd);
  return { message: 'Tạo tài khoản thành công!' };
});
route('POST', '/api/auth/login', 0, ({ body, res, ip }) => {
  if (limited('login:' + ip, 8, 60_000)) throw err(429, 'Thử lại sau ít phút.');
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(str(body.username, 20));
  const ok = verify(str(body.password, 100), u ? u.password_hash : DUMMY) && u && !u.locked; // same message for every failure
  if (!ok) throw err(401, 'Sai tài khoản hoặc mật khẩu!');
  const t = crypto.randomBytes(32).toString('hex'); sessions.set(t, { uid: u.id, exp: Date.now() + 7 * 864e5 });
  res.setHeader('Set-Cookie', `sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`);
  return { user: pub(u) };
});
route('POST', '/api/auth/logout', 1, ({ req, res }) => { sessions.delete(cookie(req).sid); res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0'); return { ok: true }; });
route('GET', '/api/auth/me', 1, ({ user }) => ({ user: pub(user) }));
route('GET', '/api/services', 1, ({ user }) => ({ services: db.prepare('SELECT id,name,category,description,price,active FROM services' + (user.role === 'admin' ? '' : ' WHERE active=1') + ' ORDER BY id').all() }));
route('POST', '/api/services/:id/purchase', 1, ({ user, params }) => tx(() => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(user.id), s = db.prepare('SELECT * FROM services WHERE id=? AND active=1').get(params[0]);
  if (!u) throw err(404, 'Người dùng không tồn tại.'); if (!s) throw err(404, 'Dịch vụ không tồn tại.');
  const ub = pubBalance(u.balance), price = moneyString(s.price);
  if (price === null || price === 'Infinity' || BigInt(price) < 0n) throw err(500, 'Giá dịch vụ không hợp lệ.');
  if (ub !== 'Infinity' && BigInt(ub) < BigInt(price)) throw err(402, 'Số dư không đủ để mua dịch vụ này.');
  const newBalance = ub === 'Infinity' ? 'Infinity' : (BigInt(ub) - BigInt(price)).toString();
  db.prepare('UPDATE users SET balance=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(newBalance, u.id);
  const o = db.prepare('INSERT INTO orders(user_id,service_id,service_name,price,file) VALUES(?,?,?,?,?)').run(u.id, s.id, s.name, s.price, s.file);
  db.prepare('INSERT INTO transactions(user_id,amount,type,reason) VALUES(?,?,?,?)').run(u.id, -s.price, 'purchase', s.name);
  return { message: 'Mua dịch vụ thành công!', order_id: Number(o.lastInsertRowid), balance: newBalance };
}));
route('GET', '/api/orders', 1, ({ user }) => ({ orders: db.prepare('SELECT id,service_name,price,created_at FROM orders WHERE user_id=? ORDER BY id DESC').all(user.id) }));
route('GET', '/api/orders/:id/download', 1, ({ user, params, res }) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(params[0], user.id); // ownership check
  if (!o) throw err(404, 'Đơn hàng không hợp lệ.');
  const dir = path.join(ROOT, 'files/dichvu'), f = path.join(dir, path.basename(o.file || '')); // basename blocks traversal
  if (!f.startsWith(dir + path.sep) || !fs.existsSync(f)) throw err(404, 'File không tồn tại.');
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${path.basename(f)}"` }); fs.createReadStream(f).pipe(res); return null;
});
route('POST', '/api/recharge', 1, ({ user, body }) => {
  const prov = str(body.provider, 20).toUpperCase(), amount = body.amount, serial = str(body.serial, 30), code = str(body.card_code, 30);
  if (!PROVIDERS[prov] || !PROVIDERS[prov].includes(amount)) throw err(400, 'Nhà cung cấp hoặc mệnh giá không hợp lệ.');
  if (!/^\d{8,20}$/.test(serial) || !/^\d{8,20}$/.test(code)) throw err(400, 'Seri/mã thẻ không hợp lệ.');
  if (limited('rc:' + user.id, 5, 600_000)) throw err(429, 'Gửi thẻ quá nhiều, thử lại sau.');
  db.prepare('INSERT INTO recharge_requests(user_id,provider,amount,serial,card_code) VALUES(?,?,?,?,?)').run(user.id, prov, amount, serial, code); // status=pending; NO auto credit
  return { message: 'Đã gửi thẻ, vui lòng chờ admin duyệt.' };
});
route('GET', '/api/recharge/history', 1, ({ user }) => ({ items: db.prepare('SELECT id,provider,amount,status,created_at FROM recharge_requests WHERE user_id=? ORDER BY id DESC').all(user.id) }));
route('GET', '/api/account', 1, ({ user }) => ({ user: pub(user) }));
route('POST', '/api/account/change-password', 1, ({ user, body }) => {
  const n = str(body.new_password, 100); if (n.length < 8) throw err(400, 'Mật khẩu mới tối thiểu 8 ký tự.');
  if (!verify(str(body.old_password, 100), user.password_hash)) throw err(400, 'Mật khẩu cũ không đúng.');
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash(n), user.id); return { message: 'Đổi mật khẩu thành công.' };
});
// ---- admin ----
route('GET', '/api/admin/stats', 2, () => ({ users: db.prepare('SELECT COUNT(*) c FROM users').get().c, orders: db.prepare('SELECT COUNT(*) c FROM orders').get().c, revenue: db.prepare('SELECT COALESCE(SUM(price),0) c FROM orders').get().c, pending: db.prepare("SELECT COALESCE(SUM(amount),0) c FROM recharge_requests WHERE status='pending'").get().c, services: db.prepare('SELECT COUNT(*) c FROM services').get().c }));
route('GET', '/api/admin/users', 2, ({ q }) => ({ users: db.prepare('SELECT id,username,email,balance,role,locked,created_at FROM users WHERE username LIKE ? ORDER BY id').all('%' + (q.get('q') || '') + '%') }));
route('PATCH', '/api/admin/users/:id/balance', 2, ({ user, body, params }) => tx(() => {
  const raw = String(body.amount ?? '').trim(), reason = str(body.reason, 200) || 'admin adjust';
  const specialInfinity = raw.toLowerCase() === 'infinity' || raw === '∞';
  const delta = specialInfinity ? null : toBigIntMoney(raw);
  if (!specialInfinity && (delta === null || delta === 0n)) throw err(400, 'Số tiền không hợp lệ.');
  if (raw.toLowerCase() === '-infinity') throw err(400, 'Số tiền không hợp lệ.');
  const t = db.prepare('SELECT balance FROM users WHERE id=?').get(params[0]); if (!t) throw err(404, 'Không tìm thấy user.');
  const next = specialInfinity ? 'Infinity' : addMoney(t.balance, delta.toString());
  db.prepare('UPDATE users SET balance=? WHERE id=?').run(next, params[0]);
  db.prepare('INSERT INTO transactions(user_id,admin_id,amount,type,reason) VALUES(?,?,?,?,?)').run(params[0], user.id, specialInfinity ? 'Infinity' : delta.toString(), 'admin_adjust', reason);
  return { balance: next };
}));
route('PATCH', '/api/admin/users/:id/status', 2, ({ user, body, params }) => {
  if (+params[0] === user.id) throw err(400, 'Không thể tự khóa/đổi quyền chính mình.');
  if (body.role && !['user', 'admin'].includes(body.role)) throw err(400, 'Role không hợp lệ.');
  if (body.role) db.prepare('UPDATE users SET role=? WHERE id=?').run(body.role, params[0]);
  if (typeof body.locked === 'boolean') { db.prepare('UPDATE users SET locked=? WHERE id=?').run(+body.locked, params[0]); if (body.locked) for (const [k, s] of sessions) if (s.uid === +params[0]) sessions.delete(k); }
  return { ok: true };
});
const svcFields = b => { const name = str(b.name, 80), category = str(b.category, 20).toUpperCase(), price = moneyString(b.price); if (!name || !category || price === null || price === 'Infinity' || BigInt(price) < 0n) throw err(400, 'Dữ liệu dịch vụ không hợp lệ.'); const file = b.file ? path.basename(str(b.file, 100)) : null; return [name, category, str(b.description, 500), price, file, b.active === false ? 0 : 1]; };
route('POST', '/api/admin/services', 2, ({ body }) => { db.prepare('INSERT INTO services(name,category,description,price,file,active) VALUES(?,?,?,?,?,?)').run(...svcFields(body)); return { ok: true }; });
route('PATCH', '/api/admin/services/:id', 2, ({ body, params }) => { const f=svcFields(body); db.prepare('UPDATE services SET name=?,category=?,description=?,price=?,file=COALESCE(?,file),active=? WHERE id=?').run(...f, params[0]); return { ok: true }; });
route('DELETE', '/api/admin/services/:id', 2, ({ params }) => { db.prepare('UPDATE services SET active=0 WHERE id=?').run(params[0]); return { ok: true }; }); // soft delete keeps order history valid
route('GET', '/api/admin/recharge', 2, () => ({ items: db.prepare('SELECT r.id,u.username,r.provider,r.amount,r.serial,r.status,r.created_at FROM recharge_requests r JOIN users u ON u.id=r.user_id ORDER BY r.id DESC').all() }));
const decide = (status) => ({ user, params }) => tx(() => {
  const r = db.prepare('SELECT * FROM recharge_requests WHERE id=?').get(params[0]);
  if (!r) throw err(404, 'Không tìm thấy yêu cầu.'); if (r.status !== 'pending') throw err(409, 'Yêu cầu đã được xử lý.'); // blocks double approval
  db.prepare('UPDATE recharge_requests SET status=?,processed_at=CURRENT_TIMESTAMP WHERE id=?').run(status, r.id);
  if (status === 'approved') { db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(r.amount, r.user_id); db.prepare('INSERT INTO transactions(user_id,admin_id,amount,type,reason) VALUES(?,?,?,?,?)').run(r.user_id, user.id, r.amount, 'recharge', r.provider + ' #' + r.id); }
  return { ok: true };
});
route('PATCH', '/api/admin/recharge/:id/approve', 2, decide('approved'));
route('PATCH', '/api/admin/recharge/:id/reject', 2, decide('rejected'));
route('GET', '/api/history', 1, ({ user }) => ({ transactions: db.prepare('SELECT amount,type,reason,created_at FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 100').all(user.id), recharges: db.prepare('SELECT provider,amount,status,created_at FROM recharge_requests WHERE user_id=? ORDER BY id DESC').all(user.id) }));

// ---------- http ----------
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(c => c[0]));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const SEC = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; worker-src blob:" };
const readBody = req => new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) { req.destroy(); no(err(413, 'Quá lớn')); } }); req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { no(err(400, 'JSON lỗi')); } }); });
const server = http.createServer(async (req, res) => {
  for (const k in SEC) res.setHeader(k, SEC[k]);
  const url = new URL(req.url, 'http://x'), ip = req.socket.remoteAddress;
  try {
    if (!url.pathname.startsWith('/api/')) { // static: only /public, never /files or /data
      const f = path.join(ROOT, 'public', url.pathname === '/' ? 'index.html' : path.basename(url.pathname));
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' }); return fs.createReadStream(f).pipe(res);
    }
    const r = R.find(r => r.m === req.method && r.re.test(url.pathname)); if (!r) throw err(404, 'Không tìm thấy API.');
    if (req.method !== 'GET' && req.method !== 'DELETE' && !(req.headers['content-type'] || '').startsWith('application/json')) throw err(415, 'Cần JSON.'); // CSRF guard (+SameSite=Strict)
    let user = null;
    if (r.auth) {
      const s = sessions.get(cookie(req).sid); if (!s || s.exp < Date.now()) throw err(401, 'Chưa đăng nhập.');
      user = db.prepare('SELECT * FROM users WHERE id=?').get(s.uid); if (!user || user.locked) throw err(401, 'Chưa đăng nhập.');
      if (r.auth === 2 && user.role !== 'admin') throw err(403, 'Không có quyền.');
    }
    const body = ['POST', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    const out = r.fn({ req, res, user, body, ip, q: url.searchParams, params: url.pathname.match(r.re).slice(1) });
    if (out === null) return;
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
  } catch (e) {
    if (res.headersSent) return res.end();
    const code = e.code && Number.isInteger(e.code) ? e.code : 500; if (code === 500) console.error(e);
    res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: code === 500 ? 'Lỗi máy chủ.' : e.message }));
  }
});
if (require.main === module) server.listen(PORT, () => console.log('Kwihh Project → http://localhost:' + PORT));
module.exports = server;
