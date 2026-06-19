const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const dbPath = path.join(__dirname, 'milk-locker.db');

let SQL, db;

function rowsToObjects(result) {
  if (!result || !result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => obj[col] = row[i]);
    return obj;
  });
}

function rowToObject(result) {
  const rows = rowsToObjects(result);
  return rows.length ? rows[0] : undefined;
}

function run(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
  const idResult = queryOne('SELECT last_insert_rowid() as id');
  saveDb();
  return { lastID: idResult ? idResult.id : 0, changes: 0 };
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const columns = stmt.getColumnNames();
  const rows = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    rows.push(row);
  }
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length ? rows[0] : undefined;
}

function saveDb() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

function generatePickupCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generateBatchNo() {
  const now = new Date();
  const dateStr = now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `B${dateStr}${random}`;
}

function addHours(dateStr, hours) {
  const date = new Date(dateStr);
  date.setHours(date.getHours() + hours);
  return date.toISOString().replace('T', ' ').substring(0, 19);
}

function nowStr() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function todayStr() {
  return new Date().toISOString().substring(0, 10);
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = queryOne('SELECT * FROM users WHERE username = ? AND password = ?', [username, password]);
  if (user) {
    res.json({ success: true, user: { id: user.id, username: user.username, role: user.role, name: user.name, phone: user.phone, address: user.address } });
  } else {
    res.json({ success: false, message: '用户名或密码错误' });
  }
});

app.get('/api/products', (req, res) => {
  res.json({ success: true, products: queryAll('SELECT * FROM milk_products') });
});

app.get('/api/lockers', (req, res) => {
  const lockers = queryAll(`
    SELECT l.*, bi.id as batch_item_id, bi.status as item_status, bi.resident_id, bi.product_id,
           mp.name as product_name, u.name as resident_name
    FROM lockers l
    LEFT JOIN batch_items bi ON l.current_batch_item_id = bi.id
    LEFT JOIN milk_products mp ON bi.product_id = mp.id
    LEFT JOIN users u ON bi.resident_id = u.id
    ORDER BY l.locker_code
  `);
  res.json({ success: true, lockers });
});

app.get('/api/lockers/empty', (req, res) => {
  res.json({ success: true, lockers: queryAll("SELECT * FROM lockers WHERE status = 'empty' ORDER BY locker_code") });
});

app.get('/api/subscriptions', (req, res) => {
  const { resident_id } = req.query;
  let sql = `
    SELECT s.*, mp.name as product_name, mp.brand, mp.spec, mp.price, u.name as resident_name
    FROM subscriptions s
    JOIN milk_products mp ON s.product_id = mp.id
    JOIN users u ON s.resident_id = u.id
  `;
  const params = [];
  if (resident_id) { sql += ' WHERE s.resident_id = ?'; params.push(resident_id); }
  sql += ' ORDER BY s.created_at DESC';
  res.json({ success: true, subscriptions: queryAll(sql, params) });
});

app.post('/api/subscriptions', (req, res) => {
  const { resident_id, product_id, quantity, start_date, end_date, weekdays } = req.body;
  const info = run(`INSERT INTO subscriptions (resident_id, product_id, quantity, start_date, end_date, weekdays) VALUES (?, ?, ?, ?, ?, ?)`,
    [resident_id, product_id, quantity || 1, start_date, end_date || null, weekdays || '1,2,3,4,5,6,7']);
  run(`INSERT INTO inventory_logs (product_id, change_quantity, change_type, reference_id, notes) VALUES (?, ?, 'subscribe', ?, '新增订奶')`,
    [product_id, quantity || 1, info.lastID]);
  res.json({ success: true, id: info.lastID });
});

app.put('/api/subscriptions/:id/cancel', (req, res) => {
  const { id } = req.params;
  const sub = queryOne('SELECT * FROM subscriptions WHERE id = ?', [id]);
  if (!sub) return res.json({ success: false, message: '订奶记录不存在' });
  run("UPDATE subscriptions SET status = 'cancelled' WHERE id = ?", [id]);
  run(`INSERT INTO inventory_logs (product_id, change_quantity, change_type, reference_id, notes) VALUES (?, ?, 'cancel_subscribe', ?, '取消订奶')`,
    [sub.product_id, -sub.quantity, id]);
  run(`INSERT INTO settlements (resident_id, batch_item_id, exception_id, amount, type, status, description) VALUES (?, NULL, NULL, ?, 'refund', 'completed', '退订退款')`,
    [sub.resident_id, 5 * sub.quantity]);
  res.json({ success: true });
});

app.get('/api/batches', (req, res) => {
  const { delivery_person_id, status } = req.query;
  let sql = `SELECT db.*, u.name as delivery_person_name FROM delivery_batches db JOIN users u ON db.delivery_person_id = u.id WHERE 1=1`;
  const params = [];
  if (delivery_person_id) { sql += ' AND db.delivery_person_id = ?'; params.push(delivery_person_id); }
  if (status) { sql += ' AND db.status = ?'; params.push(status); }
  sql += ' ORDER BY db.created_at DESC LIMIT 50';
  res.json({ success: true, batches: queryAll(sql, params) });
});

app.post('/api/batches', (req, res) => {
  const { delivery_person_id, batch_date } = req.query;
  const d = req.body;
  const dpid = d.delivery_person_id || delivery_person_id;
  const bdate = d.batch_date || batch_date || todayStr();
  const batch_no = generateBatchNo();
  const weekday = new Date(bdate).getDay() + 1;
  const activeSubs = queryAll(`SELECT s.* FROM subscriptions s WHERE s.status = 'active' AND s.start_date <= ? AND (s.end_date IS NULL OR s.end_date >= ?) AND s.weekdays LIKE ?`,
    [bdate, bdate, `%${weekday}%`]);
  const totalQty = activeSubs.reduce((sum, s) => sum + s.quantity, 0);
  const info = run(`INSERT INTO delivery_batches (delivery_person_id, batch_date, batch_no, total_quantity, status) VALUES (?, ?, ?, ?, 'in_progress')`,
    [dpid, bdate, batch_no, totalQty]);
  const batchId = info.lastID;
  for (const sub of activeSubs) {
    run(`INSERT INTO batch_items (batch_id, subscription_id, product_id, quantity, resident_id, pickup_code, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [batchId, sub.id, sub.product_id, sub.quantity, sub.resident_id, generatePickupCode()]);
  }
  res.json({ success: true, batch_id: batchId, batch_no, total_items: activeSubs.length });
});

app.get('/api/batches/:id/items', (req, res) => {
  const items = queryAll(`
    SELECT bi.*, mp.name as product_name, mp.brand, mp.spec, mp.price, mp.shelf_life_hours,
           u.name as resident_name, u.phone, u.address, l.locker_code
    FROM batch_items bi
    JOIN milk_products mp ON bi.product_id = mp.id
    JOIN users u ON bi.resident_id = u.id
    LEFT JOIN lockers l ON bi.locker_id = l.id
    WHERE bi.batch_id = ?
    ORDER BY bi.status, bi.id
  `, [req.params.id]);
  res.json({ success: true, items });
});

app.post('/api/batch-items/:id/place', (req, res) => {
  const { id } = req.params;
  const { locker_id } = req.body;
  const item = queryOne('SELECT bi.*, mp.shelf_life_hours FROM batch_items bi JOIN milk_products mp ON bi.product_id = mp.id WHERE bi.id = ?', [id]);
  if (!item) return res.json({ success: false, message: '批次项不存在' });
  if (item.status !== 'pending') return res.json({ success: false, message: '该批次项状态不正确' });
  const locker = queryOne('SELECT * FROM lockers WHERE id = ?', [locker_id]);
  if (!locker) return res.json({ success: false, message: '格口不存在' });
  if (locker.status !== 'empty') return res.json({ success: false, message: '格口已被占用' });
  const now = nowStr();
  const expireAt = addHours(now, item.shelf_life_hours);
  run(`UPDATE batch_items SET status = 'placed', locker_id = ?, placed_at = ?, expire_at = ? WHERE id = ?`, [locker_id, now, expireAt, id]);
  run(`UPDATE lockers SET status = 'occupied', current_batch_item_id = ? WHERE id = ?`, [id, locker_id]);
  run(`UPDATE delivery_batches SET delivered_quantity = delivered_quantity + ? WHERE id = ?`, [item.quantity, item.batch_id]);
  run(`INSERT INTO inventory_logs (product_id, change_quantity, change_type, reference_id, notes) VALUES (?, ?, 'place_locker', ?, '放入格口')`,
    [item.product_id, -item.quantity, id]);
  res.json({ success: true });
});

app.get('/api/resident/pickup-items', (req, res) => {
  const items = queryAll(`
    SELECT bi.*, mp.name as product_name, mp.brand, mp.spec, mp.price,
           l.locker_code, l.location, db.batch_no, db.batch_date
    FROM batch_items bi
    JOIN milk_products mp ON bi.product_id = mp.id
    JOIN lockers l ON bi.locker_id = l.id
    JOIN delivery_batches db ON bi.batch_id = db.id
    WHERE bi.resident_id = ? AND bi.status = 'placed'
    ORDER BY bi.placed_at DESC
  `, [req.query.resident_id]);
  res.json({ success: true, items });
});

app.post('/api/pickup', (req, res) => {
  const { batch_item_id, resident_id, pickup_code } = req.body;
  const item = queryOne(`
    SELECT bi.*, l.id as locker_id, l.locker_code, mp.price, mp.shelf_life_hours
    FROM batch_items bi
    JOIN lockers l ON bi.locker_id = l.id
    JOIN milk_products mp ON bi.product_id = mp.id
    WHERE bi.id = ?
  `, [batch_item_id]);
  if (!item) return res.json({ success: false, message: '取货记录不存在' });
  if (item.status !== 'placed') return res.json({ success: false, message: '该商品状态不正确' });
  let wrongPick = false;
  if (item.resident_id !== resident_id) wrongPick = true;
  if (item.pickup_code !== pickup_code) wrongPick = true;
  const now = nowStr();
  if (wrongPick) {
    run(`UPDATE batch_items SET status = 'wrong_pick', picked_at = ? WHERE id = ?`, [now, batch_item_id]);
    run(`UPDATE lockers SET status = 'empty', current_batch_item_id = NULL WHERE id = ?`, [item.locker_id]);
    const excId = run(`INSERT INTO exceptions (batch_item_id, type, description, status, impact_inventory, impact_settlement) VALUES (?, 'wrong_pick', '住户错拿商品', 'pending', ?, ?)`,
      [batch_item_id, -item.quantity, item.price * item.quantity]).lastID;
    run(`INSERT INTO settlements (resident_id, batch_item_id, exception_id, amount, type, status, description) VALUES (?, ?, ?, ?, 'compensation', 'pending', '错拿商品补偿')`,
      [item.resident_id, batch_item_id, excId, item.price * item.quantity]);
    run(`INSERT INTO pickup_records (batch_item_id, resident_id, locker_id, pickup_time, pickup_code_used, status, notes) VALUES (?, ?, ?, ?, ?, 'wrong_pick', '错拿商品')`,
      [batch_item_id, resident_id, item.locker_id, now, pickup_code]);
    run(`INSERT INTO inventory_logs (product_id, change_quantity, change_type, reference_id, notes) VALUES (?, ?, 'wrong_pick', ?, '错拿出库')`,
      [item.product_id, -item.quantity, batch_item_id]);
  } else {
    run(`UPDATE batch_items SET status = 'picked', picked_at = ? WHERE id = ?`, [now, batch_item_id]);
    run(`UPDATE lockers SET status = 'empty', current_batch_item_id = NULL WHERE id = ?`, [item.locker_id]);
    run(`INSERT INTO pickup_records (batch_item_id, resident_id, locker_id, pickup_time, pickup_code_used, status) VALUES (?, ?, ?, ?, ?, 'success')`,
      [batch_item_id, resident_id, item.locker_id, now, pickup_code]);
    run(`INSERT INTO settlements (resident_id, batch_item_id, exception_id, amount, type, status, description) VALUES (?, ?, NULL, ?, 'charge', 'completed', '正常取货扣费')`,
      [resident_id, batch_item_id, item.price * item.quantity]);
  }
  res.json({ success: true, wrong_pick: wrongPick });
});

app.post('/api/report-damaged', (req, res) => {
  const { batch_item_id, resident_id, description } = req.body;
  const item = queryOne('SELECT bi.*, mp.price FROM batch_items bi JOIN milk_products mp ON bi.product_id = mp.id WHERE bi.id = ?', [batch_item_id]);
  if (!item) return res.json({ success: false, message: '记录不存在' });
  const now = nowStr();
  run(`UPDATE batch_items SET status = 'damaged' WHERE id = ?`, [batch_item_id]);
  if (item.locker_id) run(`UPDATE lockers SET status = 'empty', current_batch_item_id = NULL WHERE id = ?`, [item.locker_id]);
  const excId = run(`INSERT INTO exceptions (batch_item_id, type, description, status, impact_inventory, impact_settlement) VALUES (?, 'damaged', ?, 'pending', ?, ?)`,
    [batch_item_id, description || '商品破损', -item.quantity, item.price * item.quantity]).lastID;
  run(`INSERT INTO settlements (resident_id, batch_item_id, exception_id, amount, type, status, description) VALUES (?, ?, ?, ?, 'compensation', 'pending', '破损补发/退款')`,
    [item.resident_id, batch_item_id, excId, item.price * item.quantity]);
  run(`INSERT INTO inventory_logs (product_id, change_quantity, change_type, reference_id, notes) VALUES (?, ?, 'damaged', ?, '商品破损')`,
    [item.product_id, -item.quantity, batch_item_id]);
  res.json({ success: true });
});

app.get('/api/exceptions', (req, res) => {
  const { status, type } = req.query;
  let sql = `
    SELECT e.*, bi.resident_id, bi.product_id, u.name as resident_name,
           mp.name as product_name, db.batch_no, l.locker_code
    FROM exceptions e
    JOIN batch_items bi ON e.batch_item_id = bi.id
    JOIN users u ON bi.resident_id = u.id
    JOIN milk_products mp ON bi.product_id = mp.id
    JOIN delivery_batches db ON bi.batch_id = db.id
    LEFT JOIN lockers l ON bi.locker_id = l.id
    WHERE 1=1
  `;
  const params = [];
  if (status) { sql += ' AND e.status = ?'; params.push(status); }
  if (type) { sql += ' AND e.type = ?'; params.push(type); }
  sql += ' ORDER BY e.created_at DESC LIMIT 100';
  res.json({ success: true, exceptions: queryAll(sql, params) });
});

app.post('/api/exceptions/:id/resolve', (req, res) => {
  const { id } = req.params;
  const { handled_by, action, notes } = req.body;
  const exc = queryOne('SELECT * FROM exceptions WHERE id = ?', [id]);
  if (!exc) return res.json({ success: false, message: '异常记录不存在' });
  const now = nowStr();
  run(`UPDATE exceptions SET status = 'resolved', handled_by = ?, handled_at = ? WHERE id = ?`, [handled_by, now, id]);
  run(`UPDATE settlements SET status = 'completed', description = COALESCE(description, '') || ? WHERE exception_id = ?`,
    [notes ? ` (${notes})` : '', id]);
  if (action === 're_deliver') {
    const item = queryOne('SELECT * FROM batch_items WHERE id = ?', [exc.batch_item_id]);
    run(`UPDATE batch_items SET status = 're_delivered' WHERE id = ?`, [exc.batch_item_id]);
    run(`INSERT INTO inventory_logs (product_id, change_quantity, change_type, reference_id, notes) VALUES (?, ?, 're_delivery', ?, '补送出库')`,
      [item.product_id, -item.quantity, exc.batch_item_id]);
  }
  if (action === 'refund') {
    run(`UPDATE batch_items SET status = 'returned' WHERE id = ?`, [exc.batch_item_id]);
  }
  res.json({ success: true });
});

app.post('/api/check-expired', (req, res) => {
  const now = nowStr();
  const expiredItems = queryAll(`
    SELECT bi.*, mp.price FROM batch_items bi
    JOIN milk_products mp ON bi.product_id = mp.id
    WHERE bi.status = 'placed' AND bi.expire_at < ?
  `, [now]);
  let count = 0;
  for (const item of expiredItems) {
    run(`UPDATE batch_items SET status = 'expired' WHERE id = ?`, [item.id]);
    run(`UPDATE lockers SET status = 'empty', current_batch_item_id = NULL WHERE id = ?`, [item.locker_id]);
    const excId = run(`INSERT INTO exceptions (batch_item_id, type, description, status, impact_inventory, impact_settlement) VALUES (?, 'expired', '临期未取自动过期', 'resolved', ?, ?)`,
      [item.id, -item.quantity, item.price * item.quantity]).lastID;
    run(`INSERT INTO settlements (resident_id, batch_item_id, exception_id, amount, type, status, description) VALUES (?, ?, ?, ?, 'charge', 'completed', '临期未取照常扣费')`,
      [item.resident_id, item.id, excId, item.price * item.quantity]);
    run(`INSERT INTO inventory_logs (product_id, change_quantity, change_type, reference_id, notes) VALUES (?, ?, 'expired', ?, '临期过期')`,
      [item.product_id, -item.quantity, item.id]);
    count++;
  }
  res.json({ success: true, expired_count: count });
});

app.get('/api/daily-report', (req, res) => {
  const reportDate = req.query.date || todayStr();
  const q = (sql, p) => queryOne(sql, p) || {};
  const delivered = q(`SELECT COUNT(*) as cnt, COALESCE(SUM(bi.quantity), 0) as qty FROM batch_items bi JOIN delivery_batches db ON bi.batch_id = db.id WHERE db.batch_date = ? AND bi.status != 'pending'`, [reportDate]);
  const picked = q(`SELECT COUNT(*) as cnt, COALESCE(SUM(bi.quantity), 0) as qty FROM batch_items bi JOIN delivery_batches db ON bi.batch_id = db.id WHERE db.batch_date = ? AND bi.status = 'picked'`, [reportDate]);
  const expired = q(`SELECT COUNT(*) as cnt, COALESCE(SUM(bi.quantity), 0) as qty FROM batch_items bi JOIN delivery_batches db ON bi.batch_id = db.id WHERE db.batch_date = ? AND bi.status = 'expired'`, [reportDate]);
  const damaged = q(`SELECT COUNT(*) as cnt, COALESCE(SUM(bi.quantity), 0) as qty FROM batch_items bi JOIN delivery_batches db ON bi.batch_id = db.id WHERE db.batch_date = ? AND bi.status = 'damaged'`, [reportDate]);
  const wrongPick = q(`SELECT COUNT(*) as cnt, COALESCE(SUM(bi.quantity), 0) as qty FROM batch_items bi JOIN delivery_batches db ON bi.batch_id = db.id WHERE db.batch_date = ? AND bi.status = 'wrong_pick'`, [reportDate]);
  const reDelivered = q(`SELECT COUNT(*) as cnt, COALESCE(SUM(bi.quantity), 0) as qty FROM batch_items bi JOIN delivery_batches db ON bi.batch_id = db.id WHERE db.batch_date = ? AND bi.status = 're_delivered'`, [reportDate]);
  const refunded = q(`SELECT COUNT(*) as cnt, COALESCE(SUM(bi.quantity), 0) as qty FROM batch_items bi JOIN delivery_batches db ON bi.batch_id = db.id WHERE db.batch_date = ? AND bi.status = 'returned'`, [reportDate]);
  const remaining = queryAll(`SELECT bi.id, bi.status, bi.quantity, mp.name as product_name, u.name as resident_name, l.locker_code, bi.expire_at FROM batch_items bi JOIN delivery_batches db ON bi.batch_id = db.id JOIN milk_products mp ON bi.product_id = mp.id JOIN users u ON bi.resident_id = u.id LEFT JOIN lockers l ON bi.locker_id = l.id WHERE db.batch_date = ? AND bi.status IN ('placed', 'pending') ORDER BY bi.status`, [reportDate]);
  const exceptionDetails = queryAll(`SELECT e.type, e.status, e.description, e.impact_inventory, e.impact_settlement, mp.name as product_name, u.name as resident_name FROM exceptions e JOIN batch_items bi ON e.batch_item_id = bi.id JOIN delivery_batches db ON bi.batch_id = db.id JOIN milk_products mp ON bi.product_id = mp.id JOIN users u ON bi.resident_id = u.id WHERE db.batch_date = ? ORDER BY e.type`, [reportDate]);
  const settlements = queryAll(`SELECT s.*, u.name as resident_name FROM settlements s LEFT JOIN users u ON s.resident_id = u.id WHERE DATE(s.created_at) = ? ORDER BY s.created_at DESC`, [reportDate]);
  res.json({
    success: true,
    report: {
      date: reportDate,
      total_delivered: delivered.qty || 0,
      total_picked: picked.qty || 0,
      total_expired: expired.qty || 0,
      total_damaged: damaged.qty || 0,
      total_wrong_pick: wrongPick.qty || 0,
      total_re_delivered: reDelivered.qty || 0,
      total_refunded: refunded.qty || 0,
      remaining_products: remaining,
      exception_details: exceptionDetails,
      settlements: settlements
    }
  });
});

app.get('/api/residents', (req, res) => {
  res.json({ success: true, residents: queryAll("SELECT id, name, phone, address FROM users WHERE role = 'resident' ORDER BY name") });
});

app.get('/api/inventory-logs', (req, res) => {
  res.json({ success: true, logs: queryAll(`SELECT il.*, mp.name as product_name FROM inventory_logs il JOIN milk_products mp ON il.product_id = mp.id ORDER BY il.created_at DESC LIMIT 100`) });
});

app.get('/api/settlements', (req, res) => {
  const { resident_id } = req.query;
  let sql = `SELECT s.*, u.name as resident_name FROM settlements s LEFT JOIN users u ON s.resident_id = u.id`;
  const params = [];
  if (resident_id) { sql += ' WHERE s.resident_id = ?'; params.push(resident_id); }
  sql += ' ORDER BY s.created_at DESC LIMIT 100';
  res.json({ success: true, settlements: queryAll(sql, params) });
});

(async function start() {
  SQL = await initSqlJs();
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
    console.log('数据库已加载');
  } else {
    console.log('数据库不存在，正在初始化...');
    db = new SQL.Database();
    require('./init-db.js');
    await new Promise(r => setTimeout(r, 1000));
    if (fs.existsSync(dbPath)) {
      const fileBuffer = fs.readFileSync(dbPath);
      db = new SQL.Database(fileBuffer);
    }
  }
  app.listen(PORT, () => {
    console.log(`鲜奶取货柜系统已启动: http://localhost:${PORT}`);
  });

})();
