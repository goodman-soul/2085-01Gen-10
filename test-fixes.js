const http = require('http');

function post(path, data, token = null) {
  return new Promise((res, rej) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const req = http.request({ hostname: 'localhost', port: 3001, path, method: 'POST', headers }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res({ status: r.statusCode, data: JSON.parse(d) }); } catch(e) { res({ status: r.statusCode, data: {} }); } });
    });
    req.on('error', rej);
    req.write(JSON.stringify(data)); req.end();
  });
}

function get(path, token = null) {
  return new Promise((res, rej) => {
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    http.get({ hostname: 'localhost', port: 3001, path, headers }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res({ status: r.statusCode, data: JSON.parse(d) }); } catch(e) { res({ status: r.statusCode, data: {} }); } });
    }).on('error', rej);
  });
}

(async function() {
  console.log('========== 测试 1：服务端鉴权 ==========');
  console.log('1.1 未登录访问 /api/products，期望 401:');
  const r1 = await get('/api/products');
  console.log('  状态码:', r1.status, 'need_login:', r1.data.need_login, r1.data.message);
  console.log('  ✅ 通过' + (r1.status === 401 && r1.data.need_login ? ' ✓' : ' ✗'));

  console.log('\n1.2 住户登录获取 token：');
  const loginRes = await post('/api/login', { username: 'resident1', password: '123456' });
  const userToken = loginRes.data.token;
  console.log('  登录 success:', loginRes.data.success, 'token长度:', userToken ? userToken.length : '无');
  console.log('  ✅ 通过' + (loginRes.data.success && userToken ? ' ✓' : ' ✗'));

  console.log('\n1.3 用住户 token 访问 lockers/empty（仅 delivery/property），期望 403:');
  const r3 = await get('/api/lockers/empty', userToken);
  console.log('  状态码:', r3.status, r3.data.message);
  console.log('  ✅ 通过' + (r3.status === 403 ? ' ✓' : ' ✗'));

  console.log('\n========== 测试 2：取货码错误 ==========');
  const delLogin = await post('/api/login', { username: 'delivery1', password: '123456' });
  const delToken = delLogin.data.token;

  console.log('2.1 创建订奶和批次：');
  await post('/api/subscriptions', { product_id: 1, quantity: 1, start_date: '2026-06-21', weekdays: '1,2,3,4,5,6,7' }, userToken);
  const batchRes = await post('/api/batches', { batch_date: '2026-06-21' }, delToken);
  console.log('  批次创建:', batchRes.data.batch_no, '商品数:', batchRes.data.total_items);
  const batchId = batchRes.data.batch_id;
  const items = await get('/api/batches/' + batchId + '/items', delToken);
  const firstItem = items.data.items[0];
  console.log('  首个商品ID:', firstItem.id, '取货码:', firstItem.pickup_code);

  console.log('\n2.2 投放至格口');
  await post('/api/batch-items/' + firstItem.id + '/place', { locker_id: 1 }, delToken);

  console.log('\n2.3 本人取货，输错取货码，期望 success=false，商品不消失：');
  const wrong = await post('/api/pickup', { batch_item_id: firstItem.id, pickup_code: 'WRONG1' }, userToken);
  console.log('  success:', wrong.data.success, 'message:', wrong.data.message);
  const itemsAfter = await get('/api/resident/pickup-items', userToken);
  console.log('  待取列表剩余商品数：', itemsAfter.data.items.length, '(期望 1)');
  console.log('  ✅ 通过' + (!wrong.data.success && itemsAfter.data.items.length === 1 ? ' ✓' : ' ✗'));

  console.log('\n2.4 本人取货，输对取货码，期望成功：');
  const right = await post('/api/pickup', { batch_item_id: firstItem.id, pickup_code: firstItem.pickup_code }, userToken);
  console.log('  success:', right.data.success, 'wrong_pick:', right.data.wrong_pick);
  const itemsAfter2 = await get('/api/resident/pickup-items', userToken);
  console.log('  待取列表剩余商品数：', itemsAfter2.data.items.length, '(期望 0)');
  console.log('  ✅ 通过' + (right.data.success && !right.data.wrong_pick && itemsAfter2.data.items.length === 0 ? ' ✓' : ' ✗'));

  console.log('\n========== 测试 3：补送生成新记录 ==========');
  console.log('3.1 新建另一个批次→投放→上报破损：');
  await post('/api/subscriptions', { product_id: 2, quantity: 2, start_date: '2026-06-21', weekdays: '1,2,3,4,5,6,7' }, userToken);
  const batch2 = await post('/api/batches', { batch_date: '2026-06-21' }, delToken);
  const items2 = await get('/api/batches/' + batch2.data.batch_id + '/items', delToken);
  const damageItem = items2.data.items.find(i => i.product_id === 2);
  await post('/api/batch-items/' + damageItem.id + '/place', { locker_id: 2 }, delToken);
  const rep = await post('/api/report-damaged', { batch_item_id: damageItem.id, description: '包装破损漏奶' }, userToken);
  console.log('  破损上报 success:', rep.data.success);

  console.log('\n3.2 物业登录，处理异常（选择补送）：');
  const propLogin = await post('/api/login', { username: 'property1', password: '123456' });
  const propToken = propLogin.data.token;
  const excs = await get('/api/exceptions?status=pending', propToken);
  const damageExc = excs.data.exceptions.find(e => e.type === 'damaged');
  console.log('  找到异常ID:', damageExc.id, '类型:', damageExc.type);
  const resolveRes = await post('/api/exceptions/' + damageExc.id + '/resolve', { action: 're_deliver', notes: '已经重新安排配送' }, propToken);
  console.log('  处理结果 success:', resolveRes.data.success);

  console.log('\n3.3 验证：批次中生成了新的 pending 项（补送）：');
  const itemsAfterRedel = await get('/api/batches/' + batch2.data.batch_id + '/items', delToken);
  const pending = itemsAfterRedel.data.items.filter(i => i.status === 'pending');
  const redelivered = itemsAfterRedel.data.items.filter(i => i.status === 're_delivered');
  const newPendingWithSource = pending.filter(p => p.id !== damageItem.id);
  console.log('  re_delivered 数:', redelivered.length, '(期望 1)');
  console.log('  新 pending 数:', newPendingWithSource.length, '(期望 1，带新取货码)');
  if (newPendingWithSource.length) {
    console.log('  新配送项取货码:', newPendingWithSource[0].pickup_code, '(与原项不同)');
  }
  console.log('  ✅ 通过' + (redelivered.length === 1 && newPendingWithSource.length === 1 ? ' ✓' : ' ✗'));

  console.log('\n3.4 投放补送商品→住户取货（日报验证）：');
  if (newPendingWithSource.length) {
    const newItem = newPendingWithSource[0];
    await post('/api/batch-items/' + newItem.id + '/place', { locker_id: 3 }, delToken);
    await post('/api/pickup', { batch_item_id: newItem.id, pickup_code: newItem.pickup_code }, userToken);
  }
  const report = await get('/api/daily-report?date=2026-06-21', propToken);
  console.log('  日报补送数:', report.data.report.total_re_delivered, '(期望 1 = 原补送数)');
  console.log('  日报已取货数:', report.data.report.total_picked, '(含补送后取货)');
  console.log('  ✅ 通过' + (report.data.report.total_re_delivered === 1 ? ' ✓' : ' ✗'));

  console.log('\n========== ✨ 全部测试完成 ==========');
})().catch(console.error);
