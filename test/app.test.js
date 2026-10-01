import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

async function homeFixture(checkoutEnabled, checkoutResponse, { pathname = '/', responses = {}, buyLabel = '立即下单' } = {}) {
  const requests = [];
  const submittedForms = [];
  const events = {};
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) {
      const classes = new Set();
      elements.set(selector, {
        style: {},
        dataset: {},
        classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, contains(name) { return classes.has(name); } },
        setAttribute(name, value) { this[name] = value; },
        removeAttribute(name) { delete this[name]; },
        parentElement: { setAttribute() {} },
        querySelectorAll: () => [],
      });
    }
    return elements.get(selector);
  };
  element('#agree').checked = true;
  element('#buy').textContent = buyLabel;
  element('#pay').textContent = '支付';
  const location = { pathname, search: '?orderNo=123456', host: 'shop.example', href: '/' };
  const document = {
    documentElement: { classList: { add() {} } },
    body: { append(form) { submittedForms.push(form); } },
    querySelector: element,
    createElement(tag) {
      return { tag, children: [], append(child) { this.children.push(child); }, submit() { this.submitted = true; } };
    },
  };
  const fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (responses[url]) return responses[url]();
    const data = url === '/api/session' ? { checkoutEnabled }
      : url === '/api/orders' ? { orderNo: '123456' }
      : url === '/api/orders/123456' ? { orderNo: '123456', planName: '永久', amountFen: 1999, createdAt: '2026-09-30T12:00:00Z', status: 'PENDING' }
      : url === '/api/orders/123456/pay' ? checkoutResponse || { action: 'https://zpayz.cn/submit.php', fields: { out_trade_no: '123456', money: '19.99' } }
      : { ok: true };
    return { ok: checkoutEnabled || !url.endsWith('/pay'), json: async () => data };
  };
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  await runInNewContext(`(async () => { ${source} })()`, {
    document, location, fetch, navigator: { userAgent: '' }, window: { addEventListener(name, callback) { events[name] = callback; } },
    requestAnimationFrame: callback => callback(), setTimeout: callback => { callback(); return 1; }, clearTimeout() {},
    setInterval() {}, clearInterval() {}, URLSearchParams,
  });
  if (pathname === '/order') await new Promise(resolve => setImmediate(resolve));
  return { requests, submittedForms, elements, element, location, events };
}

test('home checkout shows a waiting state before the order response and ignores repeated clicks', async () => {
  let resolveOrder;
  const orderResponse = new Promise(resolve => { resolveOrder = resolve; });
  const { requests, element, submittedForms } = await homeFixture(true, undefined, { responses: { '/api/orders': () => orderResponse } });
  const buy = element('#buy');

  const firstClick = buy.onclick();
  assert.equal(buy.disabled, true);
  assert.equal(buy.textContent, '正在跳转支付…');
  assert.equal(buy['aria-busy'], 'true');
  await buy.onclick();
  assert.equal(requests.filter(({ url }) => url === '/api/orders').length, 1);

  resolveOrder({ ok: true, json: async () => ({ orderNo: '123456' }) });
  await firstClick;
  assert.equal(submittedForms.length, 1);
  assert.equal(buy.disabled, true);
});

test('home checkout restores its button when creating an order fails', async () => {
  const { element } = await homeFixture(true, undefined, { responses: { '/api/orders': () => Promise.reject(new Error('网络错误')) } });
  const buy = element('#buy');

  await buy.onclick();

  assert.equal(buy.disabled, false);
  assert.equal(buy.textContent, '立即下单');
  assert.equal(buy['aria-busy'], undefined);
  assert.equal(element('#toast').textContent, '网络错误');
});

test('home checkout restores the live button label after an error', async () => {
  const { element } = await homeFixture(true, undefined, { buyLabel: '立即开通', responses: { '/api/orders': () => Promise.reject(new Error('网络错误')) } });

  await element('#buy').onclick();

  assert.equal(element('#buy').textContent, '立即开通');
});

test('order checkout shows a waiting state and restores its button after payment request failure', async () => {
  let rejectPayment;
  const paymentResponse = new Promise((_, reject) => { rejectPayment = reject; });
  const { requests, element } = await homeFixture(true, undefined, { pathname: '/order', responses: { '/api/orders/123456/pay': () => paymentResponse } });
  const pay = element('#pay');

  const firstClick = pay.onclick();
  assert.equal(pay.disabled, true);
  assert.equal(pay.textContent, '正在跳转支付…');
  await pay.onclick();
  assert.equal(requests.filter(({ url }) => url.endsWith('/pay')).length, 1);

  rejectPayment(new Error('支付暂时不可用'));
  await firstClick;
  assert.equal(pay.disabled, false);
  assert.equal(pay.textContent, '支付');
  assert.equal(element('#toast').textContent, '支付暂时不可用');
});

test('returning to a cached checkout page clears its waiting state', async () => {
  const { element, events } = await homeFixture(true);
  const buy = element('#buy');
  await buy.onclick();
  assert.equal(buy.disabled, true);

  events.pageshow({ persisted: true });

  assert.equal(buy.disabled, false);
  assert.equal(buy.textContent, '立即下单');
});

test('clicking 立即开通 creates the selected order and submits ZPAY without another click', async () => {
  const { requests, submittedForms, element, location } = await homeFixture(true);

  await element('#buy').onclick();

  assert.deepEqual(requests.filter(({ url }) => url === '/api/orders' || url.endsWith('/pay')).map(({ url }) => url), [
    '/api/orders', '/api/orders/123456/pay',
  ]);
  assert.equal(submittedForms.length, 1);
  assert.equal(submittedForms[0].action, 'https://zpayz.cn/submit.php');
  assert.equal(submittedForms[0].submitted, true);
  assert.deepEqual(submittedForms[0].children.map(({ name, value }) => [name, value]), [
    ['out_trade_no', '123456'], ['money', '19.99'],
  ]);
  assert.equal(location.href, '/');
});

test('WeChat checkout opens the direct payment URL without submitting a QR checkout form', async () => {
  const payurl = 'https://mall.z-pay.cn/pay/wxpay2/index2.php?order=123';
  const { submittedForms, element, location } = await homeFixture(true, { redirectUrl: payurl });

  await element('#buy').onclick();

  assert.equal(location.href, payurl);
  assert.equal(submittedForms.length, 0);
});

test('clicking 立即开通 still opens the order page when checkout is disabled', async () => {
  const { requests, submittedForms, element, location } = await homeFixture(false);

  await element('#buy').onclick();

  assert.deepEqual(requests.filter(({ url }) => url === '/api/orders' || url.endsWith('/pay')).map(({ url }) => url), ['/api/orders']);
  assert.equal(submittedForms.length, 0);
  assert.equal(location.href, '/order?orderNo=123456');
});
