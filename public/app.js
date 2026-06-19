const API_BASE = '/api';

const api = {
  async request(url, options = {}) {
    const res = await fetch(API_BASE + url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    return res.json();
  },
  login(username, password) {
    return this.request('/login', { method: 'POST', body: { username, password } });
  },
  getProducts() { return this.request('/products'); },
  getLockers() { return this.request('/lockers'); },
  getEmptyLockers() { return this.request('/lockers/empty'); },
  getSubscriptions(residentId) {
    return this.request('/subscriptions' + (residentId ? `?resident_id=${residentId}` : ''));
  },
  createSubscription(data) {
    return this.request('/subscriptions', { method: 'POST', body: data });
  },
  cancelSubscription(id) {
    return this.request(`/subscriptions/${id}/cancel`, { method: 'PUT' });
  },
  getBatches(deliveryPersonId, status) {
    let qs = [];
    if (deliveryPersonId) qs.push(`delivery_person_id=${deliveryPersonId}`);
    if (status) qs.push(`status=${status}`);
    return this.request('/batches' + (qs.length ? '?' + qs.join('&') : ''));
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
  getPickupItems(residentId) {
    return this.request(`/resident/pickup-items?resident_id=${residentId}`);
  },
  pickup(data) {
    return this.request('/pickup', { method: 'POST', body: data });
  },
  reportDamaged(data) {
    return this.request('/report-damaged', { method: 'POST', body: data });
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
  localStorage.removeItem('user');
  window.location.href = 'index.html';
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
