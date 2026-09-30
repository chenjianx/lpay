import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../store.js';
import { createAppServer } from '../server.js';

test('visitor creates a priced order and cannot read another visitor order', async () => {
  const store = createStore(':memory:');
  const server = createAppServer({ store, adminPassword: 'test-secret', checkoutEnabled: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const visit = await fetch(base + '/api/session');
    const cookie = visit.headers.get('set-cookie').split(';')[0];
    const created = await fetch(base + '/api/orders', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ planId: 'forever', amountFen: 1 }) });
    assert.equal(created.status, 201);
    const order = await created.json();
    assert.equal(order.amountFen, 1999);
    const payment = await fetch(base + `/api/orders/${order.orderNo}/pay`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(payment.status, 503);
    const outsider = await fetch(base + `/api/orders/${order.orderNo}`, { headers: { Cookie: 'visitor=other' } });
    assert.equal(outsider.status, 403);
  } finally { server.close(); store.close(); }
});

test('admin endpoints require login and show order totals', async () => {
  const store = createStore(':memory:');
  const server = createAppServer({ store, adminPassword: 'test-secret', checkoutEnabled: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/api/admin/stats')).status, 401);
    const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-secret' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const stats = await fetch(base + '/api/admin/stats', { headers: { Cookie: cookie } });
    assert.equal(stats.status, 200);
    assert.equal((await stats.json()).payments.totalFen, 0);
  } finally { server.close(); store.close(); }
});

test('HTTPS mode marks visitor and admin cookies Secure', async () => {
  const store = createStore(':memory:');
  const server = createAppServer({ store, adminPassword: 'test-secret', secureCookies: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const visit = await fetch(base + '/api/session');
    assert.match(visit.headers.get('set-cookie'), /; Secure(?:;|$)/);
    const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-secret' }) });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /; Secure(?:;|$)/);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const logout = await fetch(base + '/api/admin/logout', { method: 'POST', headers: { Cookie: cookie } });
    assert.match(logout.headers.get('set-cookie'), /; Secure(?:;|$)/);
  } finally { server.close(); store.close(); }
});
