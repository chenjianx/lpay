import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../store.js';

test('orders use server prices and paid metrics count once', () => {
  const store = createStore(':memory:');
  const order = store.createOrder('year', 'visitor-1');
  assert.equal(order.amountFen, 1399);
  assert.throws(() => store.createOrder('unknown', 'visitor-1'));
  store.markPaid(order.orderNo, 1399, 'wx-transaction-1', '2026-09-30T03:00:00+08:00');
  store.markPaid(order.orderNo, 1399, 'wx-transaction-1', '2026-09-30T03:00:00+08:00');
  assert.throws(() => store.markPaid(order.orderNo, 999, 'wrong', '2026-09-30T03:00:00+08:00'));
  assert.deepEqual(store.stats().payments, { count: 1, totalFen: 1399 });
  store.close();
});

test('analytics distinguishes page views, unique visitors and clicks', () => {
  const store = createStore(':memory:');
  store.recordEvent('visitor-1', 'page_view', '/');
  store.recordEvent('visitor-1', 'page_view', '/');
  store.recordEvent('visitor-2', 'page_view', '/');
  store.recordEvent('visitor-1', 'click', 'part_time');
  assert.equal(store.stats().pageViews, 3);
  assert.equal(store.stats().visitors, 2);
  assert.equal(store.stats().clicks, 1);
  store.close();
});

test('customer chat persists visitor and staff messages', () => {
  const store = createStore(':memory:');
  store.addMessage('visitor-1', 'visitor', '你好');
  store.addMessage('visitor-1', 'staff', '您好');
  assert.deepEqual(store.messages('visitor-1').map(x => x.body), ['你好', '您好']);
  assert.equal(store.conversations()[0].visitorId, 'visitor-1');
  store.close();
});
