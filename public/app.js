const API_BASE = '/api';

const TOKEN_KEY = 'auth_token';

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

const api = {
  async request(url, options = {}) {
    const token = getToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(API_BASE + url, {
      headers, ...options,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    let data;
    try { data = await res.json(); } catch (e) { data = {}; }
    if (res.status === 401 || data.need_login) {
      setToken(null);
      localStorage.removeItem('user');
      alert('登录已过期，请重新登录');
      window.location.href = 'index.html';
      throw new Error('need_login');
    }
    if (res.status === 403) {
      alert(data.message || '无权限访问');
      throw new Error('forbidden');
    }
    return data;
  },
  async login(username, password) {
    const data = await this.request('/login', { method: 'POST', body: { username, password } });
    if (data.success && data.token) setToken(data.token);
    return data;
  },
  async logout() {
    try { await this.request('/logout', { method: 'POST' }); } catch (e) {}
    setToken(null);
    localStorage.removeItem('user');
    window.location.href = 'index.html';
  },
  getProducts() { return this.request('/products'); },
  getLockers() { return this.request('/lockers'); },
  getEmptyLockers() { return this.request('/lockers/empty'); },
  getSubscriptions() { return this.request('/subscriptions'); },
  createSubscription(data) {
    return this.request('/subscriptions', { method: 'POST', body: data });
  },
  cancelSubscription(id) {
    return this.request(`/subscriptions/${id}/cancel`, { method: 'PUT' });
  },
  getBatches(status) {
    return this.request('/batches' + (status ? `?status=${status}` : ''));
  },
  createBatch(data) {
    return this.request('/batches', { method: 'POST', body: data });
  },
  getBatchItems(batchId) {
    return this.request(`/batches/${batchId}/items`);
  },
  placeBatchItem(itemId, lockerId) {
    return this.request(`/batch-items/${itemId}/place`, { method: 'POST', body: { locker_id: lockerId } });
  },
  getPickupItems() {
    return this.request('/resident/pickup-items');
  },
  pickup(batch_item_id, pickup_code) {
    return this.request('/pickup', { method: 'POST', body: { batch_item_id, pickup_code } });
  },
  reportDamaged(batch_item_id, description) {
    return this.request('/report-damaged', { method: 'POST', body: { batch_item_id, description } });
  },
  getExceptions(status, type) {
    let qs = [];
    if (status) qs.push(`status=${status}`);
    if (type) qs.push(`type=${type}`);
    return this.request('/exceptions' + (qs.length ? '?' + qs.join('&') : ''));
  },
  resolveException(id, data) {
    return this.request(`/exceptions/${id}/resolve`, { method: 'POST', body: data });
  },
  checkExpired() {
    return this.request('/check-expired', { method: 'POST' });
  },
  getDailyReport(date) {
    return this.request('/daily-report' + (date ? `?date=${date}` : ''));
  },
  getResidents() { return this.request('/residents'); },
  getInventoryLogs() { return this.request('/inventory-logs'); },
  getSettlements(residentId) {
    return this.request('/settlements' + (residentId ? `?resident_id=${residentId}` : ''));
  }
};

function getUser() {
  try { return JSON.parse(localStorage.getItem('user')); } catch { return null; }
}

function logout() {
  api.logout().catch(() => {
    setToken(null);
    localStorage.removeItem('user');
    window.location.href = 'index.html';
  });
}

function todayStr() {
  return new Date().toISOString().substring(0, 10);
}

function statusBadge(status) {
  const map = {
    'pending': '<span class="badge bg-secondary">待投放</span>',
    'placed': '<span class="badge bg-info">已投放</span>',
    'picked': '<span class="badge bg-success">已取货</span>',
    'expired': '<span class="badge bg-warning text-dark">已过期</span>',
    'damaged': '<span class="badge bg-danger">破损</span>',
    'wrong_pick': '<span class="badge bg-danger">错拿</span>',
    'returned': '<span class="badge bg-secondary">已退订</span>',
    're_delivered': '<span class="badge bg-primary">已补送</span>',
    'active': '<span class="badge bg-success">有效</span>',
    'paused': '<span class="badge bg-warning text-dark">暂停</span>',
    'cancelled': '<span class="badge bg-secondary">已取消</span>',
    'empty': '<span class="badge bg-success">空闲</span>',
    'occupied': '<span class="badge bg-primary">占用中</span>',
    'in_progress': '<span class="badge bg-primary">进行中</span>',
    'completed': '<span class="badge bg-success">已完成</span>'
  };
  return map[status] || status;
}

function lockerStatusBadge(status) {
  const map = {
    'empty': 'bg-success',
    'occupied': 'bg-primary',
    'reserved': 'bg-warning text-dark',
    'maintenance': 'bg-danger'
  };
  const text = { 'empty': '空闲', 'occupied': '占用中', 'reserved': '预留', 'maintenance': '维护' };
  return `<span class="badge ${map[status] || 'bg-secondary'}">${text[status] || status}</span>`;
}

function exceptionTypeBadge(type) {
  const map = {
    'expired': 'bg-warning text-dark',
    'wrong_pick': 'bg-danger',
    'damaged': 'bg-danger',
    're_delivery': 'bg-primary',
    'refund': 'bg-info'
  };
  const text = { 'expired': '临期未取', 'wrong_pick': '错拿', 'damaged': '破损', 're_delivery': '补送', 'refund': '退订' };
  return `<span class="badge ${map[type] || 'bg-secondary'}">${text[type] || type}</span>`;
}
