const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dbPath = path.join(__dirname, 'milk-locker.db');
let SQL, db;
const activeTokens = new Map();

function run(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
  const idR = queryOne('SELECT last_insert_rowid() as id');
  saveDb();
  return { lastID: idR ? idR.id : 0, changes: 0 };
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length ? rows[0] : undefined;
}

function saveDb() {
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

function generatePickupCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}
function generateBatchNo() {
  const n = new Date();
  const d = n.getFullYear() + String(n.getMonth()+1).padStart(2,'0') + String(n.getDate()).padStart(2,'0');
  return 'B' + d + Math.floor(Math.random()*10000).toString().padStart(4,'0');
}
function addHours(ds, h) { const d = new Date(ds); d.setHours(d.getHours()+h); return d.toISOString().replace('T',' ').substring(0,19); }
function nowStr() { return new Date().toISOString().replace('T',' ').substring(0,19); }
function todayStr() { return new Date().toISOString().substring(0,10); }

function generateToken(userId) {
  return crypto.randomBytes(24).toString('hex') + '.' + userId + '.' + Date.now();
}

function authMiddleware(roles = []) {
  return function(req, res, next) {
    const t = req.headers.authorization || req.headers['x-auth-token'];
    if (!t) return res.status(401).json({ success: false, message: '未登录，请先登录', need_login: true });
    const tk = t.replace('Bearer ', '');
    const info = activeTokens.get(tk);
    if (!info || info.expireAt < Date.now()) {
      activeTokens.delete(tk);
      return res.status(401).json({ success: false, message: '登录已过期，请重新登录', need_login: true });
    }
    if (roles.length && !roles.includes(info.user.role))
      return res.status(403).json({ success: false, message: '权限不足' });
    req.user = info.user; req.token = tk; next();
  };
}

function addToken(token, info) { activeTokens.set(token, info); }
function removeToken(t) { activeTokens.delete(t); }

async function initDb() {
  SQL = await initSqlJs();
  if (fs.existsSync(dbPath)) {
    db = new SQL.Database(fs.readFileSync(dbPath));
    console.log('数据库已加载');
    try {
      const bc = queryAll("PRAGMA table_info(batch_items)").map(c => c.name);
      if (!bc.includes('source_exception_id')) {
        run('ALTER TABLE batch_items ADD COLUMN source_exception_id INTEGER');
        run('ALTER TABLE batch_items ADD COLUMN re_delivered_to_item_id INTEGER');
        run('ALTER TABLE batch_items ADD COLUMN re_delivery_exception_id INTEGER');
        console.log('已升级 batch_items');
      }
      const ec = queryAll("PRAGMA table_info(exceptions)").map(c => c.name);
      if (!ec.includes('source_resolved_exception_id')) {
        run('ALTER TABLE exceptions ADD COLUMN source_resolved_exception_id INTEGER');
        console.log('已升级 exceptions');
      }
    } catch(e) { console.log('升级检查:', e.message); }
  } else {
    console.log('数据库不存在，正在初始化...');
    db = new SQL.Database();
    require('./init-db.js');
    await new Promise(r => setTimeout(r, 1500));
    if (fs.existsSync(dbPath)) db = new SQL.Database(fs.readFileSync(dbPath));
  }
}

module.exports = {
  run, queryAll, queryOne, saveDb,
  generatePickupCode, generateBatchNo, addHours, nowStr, todayStr,
  generateToken, authMiddleware, addToken, removeToken, initDb,
  getDb: () => db
};
