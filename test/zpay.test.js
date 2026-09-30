import test from 'node:test';
import assert from 'node:assert/strict';
import { createZpayCheckout } from '../zpay.js';

test('legacy alphanumeric orders fail as a client conflict instead of a server error', () => {
  const config = { pid: 'merchant-1', key: 'secret', baseUrl: 'https://shop.example' };
  const order = { orderNo: 'RP123', planName: '一个月', amountFen: 999 };
  assert.throws(() => createZpayCheckout(config, order), error => error.status === 409);
});
