const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const dbPath = path.join(__dirname, 'milk-locker.db');
let SQL, db;

const activeTokens = new Map();

function generateToken(userId) {
  return crypto.randomBytes(24).toString('hex') + '.' + userId + '.' + Date.now();
}

function authMiddleware(roles = []) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization || req.headers['x-auth-token'];
    if (!authHeader) {
      return res.status(401).json({ success: false, message: '未登录，请先登录', need_login: true });
    }
    const token = authHeader.replace('Bearer ', '');
    const tokenInfo = activeTokens.get(token);
    if (!tokenInfo) {
      return res.status(401).json({ success: false, message: '登录已过期，请重新登录', need_login: true });
    }
    if (tokenInfo.expireAt < Date.now()) {
      activeTokens.delete(token);
      return res.status(401).json({ success: false, message: '登录已过期，请重新登录', need_login: true });
    }
    if (roles.length && !roles.includes(tokenInfo.user.role)) {
      return res.status(403).json({ success: false, message: '权限不足' });
    }
    req.user = tokenInfo.user;
    req.token = token;
    next();
  };
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
    const token = generateToken(user.id);
    const tokenInfo = {
      user: { id: user.id, username: user.username, role: user.role, name: user.name, phone: user.phone, address: user.address },
      expireAt: Date.now() + 24 * 60 * 60 * 1000
    };
    activeTokens.set(token, tokenInfo);
    return res.json({
      success: true,
      token,
      user: tokenInfo.user
    });
  }
  res.json({ success: false, message: '用户名或密码错误' });
});

app.post('/api/logout', authMiddleware(), (req, res) => {
  activeTokens.delete(req.token);
  res.json({ success: true });
});

app.get('/api/products', authMiddleware(), (req, res) => {
  res.json({ success: true, products: queryAll('SELECT * FROM milk_products') });
});

app.get('/api/lockers', authMiddleware(), (req, res) => {
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

app.get('/api/lockers/empty', authMiddleware(), (req, res) => {
  res.json({ success: true, lockers: queryAll("SELECT * FROM lockers WHERE status = 'empty' ORDER BY locker_code") });
});

app.get('/api/subscriptions', authMiddleware(), (req, res) => {
  const { resident_id } = req.query;
  let sql = `
    SELECT s.*, mp.name as product_name, mp.brand, mp.spec, mp.price, u.name as resident_name
    FROM subscriptions s
    JOIN milk_products mp ON s.product_id = mp.id
    JOIN users u ON s.resident_id = u.id
  `;
  const params = [];
  if (req.user.role === 'resident') {
    sql += ' WHERE s.resident_id = ?';
    params.push(req.user.id);
  } else if (resident_id) {
    sql += ' WHERE s.resident_id = ?';
    params.push(resident_id);
  }
  sql += ' ORDER BY s.created_at DESC';
  res.json({ success: true, subscriptions: queryAll(sql, params) });
});

app.post('/api/subscriptions', authMiddleware(['resident', 'property', 'delivery']), (req, res) => {
  const { resident_id, product_id, quantity, start_date, end_date, weekdays } = req.body;
  const actualResidentId = req.user.role === 'resident' ? req.user.id : resident_id;
  if (!actualResidentId) return res.json({ success: false, message: '缺少住户ID' });

  const info = run(`INSERT INTO subscriptions (resident_id, product_id, quantity, start_date, end_date, weekdays) VALUES (?, ?, ?, ?, ?, ?)`,
    [actualResidentId, product_id, quantity || 1, start_date, end_date || null, weekdays || '1,2,3,4,5,6,7']);
  run(`INSERT INTO inventory_logs (product_id, change_quantity, change_type, reference_id, notes) VALUES (?, ?, 'subscribe', ?, '新增订奶')`,
    [product_id, quantity || 1, info.lastID]);
  res.json({ success: true, id: info.lastID });
});

app.put('/api/subscriptions/:id/cancel', authMiddleware(), (req, res) => {
  const { id } = req.params;
  const sub = queryOne('SELECT * FROM subscriptions WHERE id = ?', [id]);
  if (!sub) return res.json({ success: false, message: '订奶记录不存在' });
  if (req.user.role === 'resident' && sub.resident_id !== req.user.id) {
    return res.status(403).json({ success: false, message: '权限不足' });
  }

  run("UPDATE subscriptions SET status = 'cancelled' WHERE id = ?", [id]);
  run(`INSERT INTO inventory_logs (product_id, change_quantity, change_type, reference_id, notes) VALUES (?, ?, 'cancel_subscribe', ?, '取消订奶')`,
    [sub.product_id, -sub.quantity, id]);
  const product = queryOne('SELECT price FROM milk_products WHERE id = ?', [sub.product_id]);
  const price = product ? product.price : 5;
  run(`INSERT INTO settlements (resident_id, batch_item_id, exception_id, amount, type, status, description) VALUES (?, NULL, NULL, ?, 'refund', 'completed', '退订退款')`,
    [sub.resident_id, price * sub.quantity]);
  res.json({ success: true });
});

app.get('/api/batches', authMiddleware(['delivery', 'property']), (req, res) => {
  const { delivery_person_id, status } = req.query;
  let sql = `SELECT db.*, u.name as delivery_person_name FROM delivery_batches db JOIN users u ON db.delivery_person_id = u.id WHERE 1=1`;
  const params = [];
  if (req.user.role === 'delivery') {
    sql += ' AND db.delivery_person_id = ?';
    params.push(req.user.id);
  } else if (delivery_person_id) {
    sql += ' AND db.delivery_person_id = ?';
    params.push(delivery_person_id);
  }
  if (status) { sql += ' AND db.status = ?'; params.push(status); }
  sql += ' ORDER BY db.created_at DESC LIMIT 50';
  res.json({ success: true, batches: queryAll(sql, params) });
});

app.post('/api/batches', authMiddleware(['delivery']), (req, res) => {
  const d = req.body;
  const dpid = req.user.id;
  const bdate = d.batch_date || todayStr();
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

app.get('/api/batches/:id/items', authMiddleware(['delivery', 'property']), (req, res) => {
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

app.post('/api/batch-items/:id/place', authMiddleware(['delivery']), (req, res) => {
  const { id } = req.params;
  const { locker_id } = req.body;
  const item = queryOne('SELECT bi.*, mp.shelf_life_hours FROM batch_items bi JOIN milk_products mp ON bi.product_id = mp.id WHERE bi.id = ?', [id]);
  if (!item) return res.json({ success: false, message: '批次项不存在' });
  
  const validPlaceStatus = ['pending', 're_delivery_pending'];
  if (!validPlaceStatus.includes(item.status)) {
    return res.json({ success: false, message: '该批次项状态不正确，当前状态：' + item.status });
  }
  const locker = queryOne('SELECT * FROM lockers WHERE id = ?', [locker_id]);
  if (!locker) return res.json({ success: false, message: '格口不存在' });
  if (locker.status !== 'empty') return res.json({ success: false, message: '格口已被占用' });

  const now = nowStr();
  const expireAt = addHours(now, item.shelf_life_hours);
  run(`UPDATE batch_items SET status = 'placed', locker_id = ?, placed_at = ?, expire_at = ? WHERE id = ?`, [locker_id, now, expireAt, id]);
  run(`UPDATE lockers SET status = 'occupied', current_batch_item_id = ? WHERE id = ?`, [id, locker_id]);
  if (item.status === 'pending') {
    run(`UPDATE delivery_batches SET delivered_quantity = delivered_quantity + ? WHERE id = ?`, [item.quantity, item.batch_id]);
  }
  run(`INSERT INTO inventory_logs (product_id, change_quantity, change_type, reference_id, notes) VALUES (?, ?, 'place_locker', ?, '放入格口')`,
    [item.product_id, -item.quantity, id]);
  res.json({ success: true });
});

app.get('/api/resident/pickup-items', authMiddleware(['resident']), (req, res) => {
  const items = queryAll(`
    SELECT bi.*, mp.name as product_name, mp.brand, mp.spec, mp.price,
           l.locker_code, l.location, db.batch_no, db.batch_date
    FROM batch_items bi
    JOIN milk_products mp ON bi.product_id = mp.id
    JOIN lockers l ON bi.locker_id = l.id
    JOIN delivery_batches db ON bi.batch_id = db.id
    WHERE bi.resident_id = ? AND bi.status = 'placed'
    ORDER BY bi.placed_at DESC
  `, [req.user.id]);
  res.json({ success: true, items });
});

app.post('/api/pickup', authMiddleware(['resident']), (req, res) => {
  const { batch_item_id, pickup_code } = req.body;
  const resident_id = req.user.id;

  const item = queryOne(`
    SELECT bi.*, l.id as locker_id, l.locker_code, mp.price, mp.shelf_life_hours
    FROM batch_items bi
    JOIN lockers l ON bi.locker_id = l.id
    JOIN milk_products mp ON bi.product_id = mp.id
    WHERE bi.id = ?
  `, [batch_item_id]);

  if (!item) return res.json({ success: false, message: '取货记录不存在' });
  if (item.status !== 'placed') return res.json({ success: false, message: '该商品状态不正确' });

  if (item.pickup_code !== pickup_code) {
    return res.json({ success: false, message: '取货码错误，请重新输入', code_error: true });
  }

  let wrongPick = false;
  if (item.resident_id !== resident_id) wrongPick = true;

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
    return res.json({ success: true, wrong_pick: true, message: '已记录错拿，原住户将获得补送或退款' });
  }

  run(`UPDATE batch_items SET status = 'picked', picked_at = ? WHERE id = ?`, [now, batch_item_id]);
  run(`UPDATE lockers SET status = 'empty', current_batch_item_id = NULL WHERE id = ?`, [item.locker_id]);
  run(`INSERT INTO pickup_records (batch_item_id, resident_id, locker_id, pickup_time, pickup_code_used, status) VALUES (?, ?, ?, ?, ?, 'success')`,
    [batch_item_id, resident_id, item.locker_id, now, pickup_code]);
  run(`INSERT INTO settlements (resident_id, batch_item_id, exception_id, amount, type, status, description) VALUES (?, ?, NULL, ?, 'charge', 'completed', '正常取货扣费')`,
    [resident_id, batch_item_id, item.price * item.quantity]);
  res.json({ success: true, wrong_pick: false });
});

app.post('/api/report-damaged', authMiddleware(['resident']), (req, res) => {
  const { batch_item_id, description } = req.body;
  const resident_id = req.user.id;
  const item = queryOne('SELECT bi.*, mp.price FROM batch_items bi JOIN milk_products mp ON bi.product_id = mp.id WHERE bi.id = ?', [batch_item_id]);
  if (!item) return res.json({ success: false, message: '记录不存在' });
  if (item.resident_id !== resident_id) return res.status(403).json({ success: false, message: '权限不足' });
  if (!['placed', 'picked'].includes(item.status)) {
    return res.json({ success: false, message: '当前状态无法上报破损' });
  }

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

app.get('/api/exceptions', authMiddleware(['property', 'delivery']), (req, res) => {
  const { status, type } = req.query;
  let sql = `
    SELECT e.*, bi.resident_id, bi.product_id, bi.quantity as item_quantity, bi.batch_id,
           u.name as resident_name, u.phone, u.address,
           mp.name as product_name, mp.shelf_life_hours, db.batch_no, l.locker_code
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

app.post('/api/exceptions/:id/resolve', authMiddleware(['property', 'delivery']), (req, res) => {
  const { id } = req.params;
  const { action, notes } = req.body;
  const handled_by = req.user.id;

  const exc = queryOne(`
    SELECT e.*, bi.resident_id, bi.product_id, bi.quantity, bi.batch_id, bi.subscription_id,
           mp.shelf_life_hours
    FROM exceptions e
    JOIN batch_items bi ON e.batch_item_id = bi.id
    JOIN milk_products mp ON bi.product_id = mp.id
    WHERE e.id = ?
  `, [id]);
  if (!exc) return res.json({ success: false, message: '异常记录不存在' });
  if (exc.status === 'resolved') return res.json({ success: false, message: '该异常已处理' });

  const now = nowStr();
  run(`UPDATE exceptions SET status = 'resolved', handled_by = ?, handled_at = ? WHERE id = ?`, [handled_by, now, id]);
  run(`UPDATE settlements SET status = 'completed', description = COALESCE(description, '') || ? WHERE exception_id = ?`,
    [notes ? ` (${notes})` : '', id]);

  if (action === 'refund') {
    run(`UPDATE batch_items SET status = 'returned' WHERE id = ?`, [exc.batch_item_id]);
  }

  if (action === 're_deliver') {
    const newPickupCode = generatePickupCode();
    const newItemId = run(`
      INSERT INTO batch_items (batch_id, subscription_id, product_id, quantity, resident_id, pickup_code, status, source_exception_id)
      VALUES (?, ?, ?, ?, ?, ?, 're_delivery_pending', ?)
    `, [exc.batch_id, exc.subscription_id, exc.product_id, exc.quantity, exc.resident_id, newPickupCode, id]).lastID;

    run(`UPDATE batch_items SET status = 're_delivered', re_delivered_to_item_id = ? WHERE id = ?`, [newItemId, exc.batch_item_id]);
    run(`INSERT INTO inventory_logs (product_id, change_quantity, change_type, reference_id, notes) VALUES (?, ?, 're_delivery_create', ?, '补送新建')`,
      [exc.product_id, 0, newItemId]);

    const reExcId = run(`
      INSERT INTO exceptions (batch_item_id, type, description, status, impact_inventory, impact_settlement, source_resolved_exception_id)
      VALUES (?, 're_delivery', ?, 'pending', 0, 0, ?)
    `, [newItemId, '补送待投放', id]).lastID;

    run(`UPDATE batch_items SET re_delivery_exception_id = ? WHERE id = ?`, [reExcId, newItemId]);
  }

  res.json({ success: true });
});

app.get('/api/delivery/re-delivery-items', authMiddleware(['delivery', 'property']), (req, res) => {
  const items = queryAll(`
    SELECT bi.*, mp.name as product_name, mp.brand, mp.spec, mp.price, mp.shelf_life_hours,
           u.name as resident_name, u.phone, u.address, l.locker_code,
           e.id as re_delivery_exception_id
    FROM batch_items bi
    JOIN milk_products mp ON bi.product_id = mp.id
    JOIN users u ON bi.resident_id = u.id
    LEFT JOIN lockers l ON bi.locker_id = l.id
    LEFT JOIN exceptions e ON e.batch_item_id = bi.id AND e.type = 're_delivery' AND e.status = 'pending'
    WHERE bi.status = 're_delivery_pending'
    ORDER BY bi.created_at DESC
  `);
  res.json({ success: true, items });
});

app.post('/api/check-expired', authMiddleware(['property', 'delivery']), (req, res) => {
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

app.get('/api/daily-report', authMiddleware(['property', 'delivery']), (req, res) => {
  const reportDate = req.query.date || todayStr();
  const q = (sql, p) => queryOne(sql, p) || {};
  const delivered = q(`SELECT COUNT(*) as cnt, COALESCE(SUM(bi.quantity), 0) as qty FROM batch_items bi JOIN delivery_batches db ON bi.batch_id = db.id WHERE db.batch_date = ? AND bi.status NOT IN ('pending', 're_delivery_pending')`, [reportDate]);
  const picked = q(`SELECT COUNT(*) as cnt, COALESCE(SUM(bi.quantity), 0) as qty FROM batch_items bi JOIN delivery_batches db ON bi.batch_id = db.id WHERE db.batch_date = ? AND bi.status = 'picked'`, [reportDate]);
  const expired = q(`SELECT COUNT(*) as cnt, COALESCE(SUM(bi.quantity), 0) as qty FROM batch_items bi JOIN delivery_batches db ON bi.batch_id = db.id WHERE db.batch_date = ? AND bi.status = 'expired'`, [reportDate]);
  const damaged = q(`SELECT COUNT(*) as cnt, COALESCE(SUM(bi.quantity), 0) as qty FROM batch_items bi JOIN delivery_batches db ON bi.batch_id = db.id WHERE db.batch_date = ? AND bi.status = 'damaged'`, [reportDate]);
  const wrongPick = q(`SELECT COUNT(*) as cnt, COALESCE(SUM(bi.quantity), 0) as qty FROM batch_items bi JOIN delivery_batches db ON bi.batch_id = db.id WHERE db.batch_date = ? AND bi.status = 'wrong_pick'`, [reportDate]);
  const reDelivered = q(`SELECT COUNT(*) as cnt, COALESCE(SUM(bi.quantity), 0) as qty FROM batch_items bi JOIN delivery_batches db ON bi.batch_id = db.id WHERE db.batch_date = ? AND bi.status = 're_delivered'`, [reportDate]);
  const reDeliveryPending = q(`SELECT COUNT(*) as cnt, COALESCE(SUM(bi.quantity), 0) as qty FROM batch_items bi JOIN delivery_batches db ON bi.batch_id = db.id WHERE db.batch_date = ? AND bi.status = 're_delivery_pending'`, [reportDate]);
  const refunded = q(`SELECT COUNT(*) as cnt, COALESCE(SUM(bi.quantity), 0) as qty FROM batch_items bi JOIN delivery_batches db ON bi.batch_id = db.id WHERE db.batch_date = ? AND bi.status = 'returned'`, [reportDate]);

  const remaining = queryAll(`SELECT bi.id, bi.status, bi.quantity, mp.name as product_name, u.name as resident_name, l.locker_code, bi.expire_at FROM batch_items bi JOIN delivery_batches db ON bi.batch_id = db.id JOIN milk_products mp ON bi.product_id = mp.id JOIN users u ON bi.resident_id = u.id LEFT JOIN lockers l ON bi.locker_id = l.id WHERE db.batch_date = ? AND bi.status IN ('placed', 'pending', 're_delivery_pending') ORDER BY bi.status`, [reportDate]);
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
      total_re_delivery_pending: reDeliveryPending.qty || 0,
      total_refunded: refunded.qty || 0,
      remaining_products: remaining,
      exception_details: exceptionDetails,
      settlements: settlements
    }
  });
});

app.get('/api/residents', authMiddleware(['property', 'delivery']), (req, res) => {
  res.json({ success: true, residents: queryAll("SELECT id, name, phone, address FROM users WHERE role = 'resident' ORDER BY name") });
});

app.get('/api/inventory-logs', authMiddleware(['property']), (req, res) => {
  res.json({ success: true, logs: queryAll(`SELECT il.*, mp.name as product_name FROM inventory_logs il JOIN milk_products mp ON il.product_id = mp.id ORDER BY il.created_at DESC LIMIT 100`) });
});

app.get('/api/settlements', authMiddleware(), (req, res) => {
  const { resident_id } = req.query;
  let sql = `SELECT s.*, u.name as resident_name FROM settlements s LEFT JOIN users u ON s.resident_id = u.id`;
  const params = [];
  if (req.user.role === 'resident') {
    sql += ' WHERE s.resident_id = ?';
    params.push(req.user.id);
  } else if (resident_id) {
    sql += ' WHERE s.resident_id = ?';
    params.push(resident_id);
  }
  sql += ' ORDER BY s.created_at DESC LIMIT 100';
  res.json({ success: true, settlements: queryAll(sql, params) });
});

(async function start() {
  SQL = await initSqlJs();
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
    console.log('数据库已加载');
    try {
      queryOne("SELECT name FROM sqlite_master WHERE type='column' AND tbl_name='batch_items' AND name='source_exception_id'");
    } catch(e) {}
    try {
      const cols = queryAll("PRAGMA table_info(batch_items)").map(c => c.name);
      if (!cols.includes('source_exception_id')) {
        run('ALTER TABLE batch_items ADD COLUMN source_exception_id INTEGER');
        run('ALTER TABLE batch_items ADD COLUMN re_delivered_to_item_id INTEGER');
        run('ALTER TABLE batch_items ADD COLUMN re_delivery_exception_id INTEGER');
        console.log('已升级 batch_items 表结构');
      }
      const excCols = queryAll("PRAGMA table_info(exceptions)").map(c => c.name);
      if (!excCols.includes('source_resolved_exception_id')) {
        run('ALTER TABLE exceptions ADD COLUMN source_resolved_exception_id INTEGER');
        console.log('已升级 exceptions 表结构');
      }
    } catch(e) { console.log('表升级跳过:', e.message); }
  } else {
    console.log('数据库不存在，正在初始化...');
    db = new SQL.Database();
    require('./init-db.js');
    await new Promise(r => setTimeout(r, 1500));
    if (fs.existsSync(dbPath)) {
      const fileBuffer = fs.readFileSync(dbPath);
      db = new SQL.Database(fileBuffer);
    }
  }
  app.listen(PORT, () => {
    console.log(`鲜奶取货柜系统已启动: http://localhost:${PORT}`);
  });
})();
