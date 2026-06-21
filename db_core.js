const fs = require('fs');
const path = require('path');
const dbPath = path.join(__dirname, 'milk-locker.db');
let SQL, db;

function initDb(sql) { SQL = sql; }
function setDb(dbObj) { db = dbObj; }
function getDb() { return db; }
function getDbPath() { return dbPath; }
function getSQL() { return SQL; }

function run(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
  const r = queryOne('SELECT last_insert_rowid() as id');
  saveDb();
  return { lastID: r ? r.id : 0, changes: 0 };
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
  const r = queryAll(sql, params);
  return r.length ? r[0] : undefined;
}

function saveDb() {
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
}

module.exports = {
  initDb, setDb, getDb, getDbPath, getSQL,
  run, queryAll, queryOne, saveDb
};
