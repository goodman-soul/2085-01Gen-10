const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dbPath = path.join(__dirname, 'milk-locker.db');
let SQL, db;
const tokens = new Map();

module.exports = {
  setDb: (sql, d) => { SQL = sql; db = d; },
  run: (sql, p = []) => {
    const s = db.prepare(sql); s.bind(p); s.step(); s.free();
    const r = module.exports.queryOne('SELECT last_insert_rowid() as id');
    const data = db.export(); fs.writeFileSync(dbPath, Buffer.from(data));
    return { lastID: r ? r.id : 0, changes: 0 };
  },
  queryAll: (sql, p = []) => {
    const s = db.prepare(sql); s.bind(p); const rows = [];
    while (s.step()) rows.push(s.getAsObject()); s.free(); return rows;
  },
  queryOne: (sql, p = []) => {
    const r = module.exports.queryAll(sql, p);
    return r.length ? r[0] : undefined;
  },
  saveDb: () => fs.writeFileSync(dbPath, Buffer.from(db.export())),
  genPickupCode: () => Math.random().toString(36).substring(2, 8).toUpperCase(),
  genBatchNo: () => {
    const n = new Date();
    const d = n.getFullYear() + String(n.getMonth()+1).padStart(2,'0') + String(n.getDate()).padStart(2,'0');
    return 'B' + d + Math.floor(Math.random()*10000).toString().padStart(4,'0');
  },
  addHours: (ds, h) => { const d = new Date(ds); d.setHours(d.getHours()+h); return d.toISOString().replace('T',' ').substring(0,19); },
  now: () => new Date().toISOString().replace('T',' ').substring(0,19),
  today: () => new Date().toISOString().substring(0,10),
  genToken: (u) => crypto.randomBytes(24).toString('hex')+'.'+u+'.'+Date.now(),
  getTokens: () => tokens,
  getDb: () => db
};
