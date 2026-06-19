const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'milk-locker.db');

(async function init() {
  const SQL = await initSqlJs();
  let db;
  
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('delivery', 'resident', 'property')),
      name TEXT NOT NULL,
      phone TEXT,
      address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS milk_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      brand TEXT,
      spec TEXT,
      price REAL NOT NULL,
      shelf_life_hours INTEGER NOT NULL DEFAULT 24,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS lockers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      locker_code TEXT UNIQUE NOT NULL,
      location TEXT,
      status TEXT NOT NULL DEFAULT 'empty' CHECK(status IN ('empty', 'occupied', 'reserved', 'maintenance')),
      current_batch_item_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resident_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      start_date DATE NOT NULL,
      end_date DATE,
      weekdays TEXT NOT NULL DEFAULT '1,2,3,4,5,6,7',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'cancelled')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS delivery_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_person_id INTEGER NOT NULL,
      batch_date DATE NOT NULL,
      batch_no TEXT UNIQUE NOT NULL,
      total_quantity INTEGER NOT NULL DEFAULT 0,
      delivered_quantity INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress', 'completed', 'cancelled')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS batch_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      subscription_id INTEGER,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      resident_id INTEGER,
      pickup_code TEXT,
      locker_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'placed', 'picked', 'expired', 'damaged', 'wrong_pick', 'returned', 're_delivered')),
      placed_at DATETIME,
      picked_at DATETIME,
      expire_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pickup_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_item_id INTEGER NOT NULL,
      resident_id INTEGER NOT NULL,
      locker_id INTEGER NOT NULL,
      pickup_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      pickup_code_used TEXT,
      status TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success', 'wrong_pick', 'damaged_report')),
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS exceptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_item_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('expired', 'wrong_pick', 'damaged', 're_delivery', 'refund')),
      description TEXT,
      handled_by INTEGER,
      handled_at DATETIME,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'resolved')),
      impact_inventory INTEGER DEFAULT 0,
      impact_settlement REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS inventory_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      change_quantity INTEGER NOT NULL,
      change_type TEXT NOT NULL,
      reference_id INTEGER,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resident_id INTEGER,
      batch_item_id INTEGER,
      exception_id INTEGER,
      amount REAL NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('charge', 'refund', 'compensation')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'cancelled')),
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS daily_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_date DATE UNIQUE NOT NULL,
      total_delivered INTEGER DEFAULT 0,
      total_picked INTEGER DEFAULT 0,
      total_expired INTEGER DEFAULT 0,
      total_damaged INTEGER DEFAULT 0,
      total_wrong_pick INTEGER DEFAULT 0,
      total_re_delivered INTEGER DEFAULT 0,
      total_refunded INTEGER DEFAULT 0,
      remaining_products TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_batch_items_status ON batch_items(status);
    CREATE INDEX IF NOT EXISTS idx_batch_items_locker ON batch_items(locker_id);
    CREATE INDEX IF NOT EXISTS idx_batch_items_resident ON batch_items(resident_id);
    CREATE INDEX IF NOT EXISTS idx_exceptions_status ON exceptions(status);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_resident ON subscriptions(resident_id);
  `);

  console.log('数据库表结构初始化完成！');

  const existingUsers = db.exec('SELECT COUNT(*) as c FROM users')[0].values[0][0];
  if (existingUsers === 0) {
    const users = [
      ['delivery1', '123456', 'delivery', '张配送', '13800138001', '配送站A'],
      ['resident1', '123456', 'resident', '李住户', '13900139001', '1号楼1单元101'],
      ['resident2', '123456', 'resident', '王住户', '13900139002', '2号楼2单元202'],
      ['property1', '123456', 'property', '赵物业', '13700137001', '物业服务中心']
    ];
    const insertUser = db.prepare('INSERT INTO users (username, password, role, name, phone, address) VALUES (?, ?, ?, ?, ?, ?)');
    users.forEach(u => insertUser.run(u));

    const products = [
      ['鲜牛奶', '蒙牛', '250ml', 5.5, 24],
      ['低脂鲜牛奶', '伊利', '250ml', 6.0, 24],
      ['高钙鲜奶', '光明', '200ml', 4.8, 24],
      ['酸奶', '蒙牛', '200g', 4.5, 48]
    ];
    const insertProduct = db.prepare('INSERT INTO milk_products (name, brand, spec, price, shelf_life_hours) VALUES (?, ?, ?, ?, ?)');
    products.forEach(p => insertProduct.run(p));

    const insertLocker = db.prepare('INSERT INTO lockers (locker_code, location) VALUES (?, ?)');
    for (let i = 1; i <= 20; i++) {
      insertLocker.run([`A${String(i).padStart(2, '0')}`, 'A区取货柜']);
    }
    console.log('示例数据插入完成！');
  }

  console.log('默认账号：');
  console.log('  配送员: delivery1 / 123456');
  console.log('  住户: resident1 / 123456, resident2 / 123456');
  console.log('  物业: property1 / 123456');

  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
  db.close();
  console.log('数据库已保存到:', dbPath);
})();
