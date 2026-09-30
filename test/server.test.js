import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { createStore } from '../store.js';
import { createAppServer } from '../server.js';

test('verification file is available from the website root', async () => {
  const store = createStore(':memory:');
  const server = createAppServer({ store, adminPassword: 'test-secret' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(base + '/7d5cd45dcd51f003b1f8120b10a805e2.txt');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/plain(?:;|$)/);
    assert.equal(await response.text(), '8b9410ecfcba862b012950b86dd8382e766d2f29');
  } finally { server.close(); store.close(); }
});

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

test('payment request returns a signed ZPAY checkout for the server-priced order', async () => {
  const store = createStore(':memory:');
  const server = createAppServer({ store, adminPassword: 'test-secret', checkoutEnabled: true, zpay: { pid: 'merchant-1', key: 'secret', baseUrl: 'https://shop.example' } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cookie = (await fetch(base + '/api/session')).headers.get('set-cookie').split(';')[0];
    const order = await (await fetch(base + '/api/orders', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ planId: 'month', amountFen: 1 }) })).json();
    const response = await fetch(base + `/api/orders/${order.orderNo}/pay`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const checkout = await response.json();
    assert.equal(checkout.action, 'https://zpayz.cn/submit.php');
    assert.equal(checkout.fields.out_trade_no, order.orderNo);
    assert.equal(checkout.fields.money, '9.99');
    assert.equal(checkout.fields.pid, 'merchant-1');
    assert.equal(checkout.fields.type, 'wxpay');
    assert.equal(checkout.fields.notify_url, 'https://shop.example/api/zpay/notify');
    assert.equal(checkout.fields.return_url, 'https://shop.example/api/zpay/return');
    const expectedSign = createHash('md5').update(`money=9.99&name=已读工具-一个月版&notify_url=https://shop.example/api/zpay/notify&out_trade_no=${order.orderNo}&pid=merchant-1&return_url=https://shop.example/api/zpay/return&type=wxpaysecret`).digest('hex');
    assert.equal(checkout.fields.sign, expectedSign);
    assert.equal(JSON.stringify(checkout).includes('secret'), false);
  } finally { server.close(); store.close(); }
});

test('WeChat payment uses ZPAY API payurl and sends the visitor IP and server-priced amount', async () => {
  let received;
  const gateway = http.createServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/mapi.php');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const multipart = Buffer.concat(chunks).toString();
    received = Object.fromEntries([...multipart.matchAll(/name="([^"]+)"\r\n\r\n([^\r\n]*)/g)].map(([, name, value]) => [name, value]));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 1, msg: 'success', payurl: 'https://mall.z-pay.cn/pay/wxpay2/index2.php?order=123', payurl2: 'https://mall.z-pay.cn/pay/wxpay2/index2.php?order=123', qrcode: 'https://example.com/qr' }));
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const store = createStore(':memory:');
  const zpay = { pid: 'merchant-1', key: 'secret', baseUrl: 'https://shop.example', apiBaseUrl: `http://127.0.0.1:${gateway.address().port}` };
  const server = createAppServer({ store, adminPassword: 'test-secret', checkoutEnabled: true, zpay });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cookie = (await fetch(base + '/api/session')).headers.get('set-cookie').split(';')[0];
    const order = await (await fetch(base + '/api/orders', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ planId: 'month', amountFen: 1 }) })).json();
    const response = await fetch(base + `/api/orders/${order.orderNo}/pay`, { method: 'POST', headers: { Cookie: cookie, 'User-Agent': 'MicroMessenger/8.0.50', 'X-Forwarded-For': '203.0.113.9' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { redirectUrl: 'https://mall.z-pay.cn/pay/wxpay2/index2.php?order=123' });
    assert.equal(received.pid, 'merchant-1');
    assert.equal(received.type, 'wxpay');
    assert.equal(received.out_trade_no, order.orderNo);
    assert.equal(received.money, '9.99');
    assert.equal(received.clientip, '203.0.113.9');
    assert.equal(received.notify_url, 'https://shop.example/api/zpay/notify');
    const expectedSign = createHash('md5').update(`clientip=203.0.113.9&device=mobile&money=9.99&name=已读工具-一个月版&notify_url=https://shop.example/api/zpay/notify&out_trade_no=${order.orderNo}&pid=merchant-1&type=wxpaysecret`).digest('hex');
    assert.equal(received.sign, expectedSign);
  } finally { server.close(); gateway.close(); store.close(); }
});

test('verified ZPAY notifications mark an order paid once and acknowledge retries', async () => {
  const store = createStore(':memory:');
  const server = createAppServer({ store, adminPassword: 'test-secret', checkoutEnabled: true, zpay: { pid: 'merchant-1', key: 'secret', baseUrl: 'https://shop.example' } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const order = store.createOrder('month', 'visitor-1');
    const fields = { pid: 'merchant-1', name: '已读工具-一个月版', money: '9.99', out_trade_no: order.orderNo, trade_no: 'zp-123', trade_status: 'TRADE_SUCCESS', type: 'wxpay', param: '', sign_type: 'MD5' };
    fields.sign = createHash('md5').update(`money=9.99&name=已读工具-一个月版&out_trade_no=${order.orderNo}&pid=merchant-1&trade_no=zp-123&trade_status=TRADE_SUCCESS&type=wxpaysecret`).digest('hex');
    const notifyUrl = `${base}/api/zpay/notify?${new URLSearchParams(fields)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(notifyUrl);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'success');
    }
    assert.equal(store.order(order.orderNo).status, 'PAID');
    assert.equal(store.order(order.orderNo).transactionId, 'zp-123');
    assert.deepEqual(store.stats().payments, { count: 1, totalFen: 999 });
  } finally { server.close(); store.close(); }
});

test('ZPAY notification rejects tampered amount and return page cannot mark paid', async () => {
  const store = createStore(':memory:');
  const server = createAppServer({ store, adminPassword: 'test-secret', checkoutEnabled: true, zpay: { pid: 'merchant-1', key: 'secret', baseUrl: 'https://shop.example' } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const order = store.createOrder('month', 'visitor-1');
    const fields = { pid: 'merchant-1', name: '已读工具-一个月版', money: '0.01', out_trade_no: order.orderNo, trade_no: 'zp-123', trade_status: 'TRADE_SUCCESS', type: 'wxpay', sign_type: 'MD5' };
    fields.sign = createHash('md5').update(`money=0.01&name=已读工具-一个月版&out_trade_no=${order.orderNo}&pid=merchant-1&trade_no=zp-123&trade_status=TRADE_SUCCESS&type=wxpaysecret`).digest('hex');
    const badAmount = await fetch(`${base}/api/zpay/notify?${new URLSearchParams(fields)}`);
    assert.equal(badAmount.status, 400);
    fields.money = '9.99';
    const badSignature = await fetch(`${base}/api/zpay/notify?${new URLSearchParams(fields)}`);
    assert.equal(badSignature.status, 401);
    const returned = await fetch(`${base}/api/zpay/return?out_trade_no=${order.orderNo}`, { redirect: 'manual' });
    assert.equal(returned.status, 302);
    assert.equal(returned.headers.get('location'), `/order?orderNo=${order.orderNo}`);
    assert.equal(store.order(order.orderNo).status, 'PENDING');
  } finally { server.close(); store.close(); }
});

test('order status reconciles a paid ZPAY transaction when notification was missed', async () => {
  const store = createStore(':memory:');
  let orderNo;
  const gateway = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    assert.equal(url.searchParams.get('act'), 'order');
    assert.equal(url.searchParams.get('pid'), 'merchant-1');
    assert.equal(url.searchParams.get('key'), 'secret');
    assert.equal(url.searchParams.get('out_trade_no'), orderNo);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 1, status: 1, pid: 'merchant-1', out_trade_no: orderNo, trade_no: 'zp-321', type: 'wxpay', money: '9.99' }));
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const zpay = { pid: 'merchant-1', key: 'secret', baseUrl: 'https://shop.example', apiBaseUrl: `http://127.0.0.1:${gateway.address().port}` };
  const server = createAppServer({ store, adminPassword: 'test-secret', checkoutEnabled: true, zpay });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cookie = (await fetch(base + '/api/session')).headers.get('set-cookie').split(';')[0];
    const created = await (await fetch(base + '/api/orders', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ planId: 'month' }) })).json();
    orderNo = created.orderNo;
    const own = await fetch(`${base}/api/orders/${created.orderNo}`, { headers: { Cookie: cookie } });
    assert.equal(own.status, 200);
    assert.equal((await own.json()).status, 'PAID');
    assert.equal(store.order(orderNo).transactionId, 'zp-321');
  } finally { server.close(); gateway.close(); store.close(); }
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
