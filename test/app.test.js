import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

async function homeFixture(checkoutEnabled, checkoutResponse) {
  const requests = [];
  const submittedForms = [];
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      style: {},
      classList: { add() {}, remove() {} },
      parentElement: { setAttribute() {} },
      querySelectorAll: () => [],
    });
    return elements.get(selector);
  };
  element('#agree').checked = true;
  const location = { pathname: '/', host: 'shop.example', href: '/' };
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
    const data = url === '/api/session' ? { checkoutEnabled }
      : url === '/api/orders' ? { orderNo: '123456' }
      : url === '/api/orders/123456/pay' ? checkoutResponse || { action: 'https://zpayz.cn/submit.php', fields: { out_trade_no: '123456', money: '19.99' } }
      : { ok: true };
    return { ok: checkoutEnabled || !url.endsWith('/pay'), json: async () => data };
  };
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  await runInNewContext(`(async () => { ${source} })()`, {
    document, location, fetch, navigator: { userAgent: '' }, window: { addEventListener() {} },
    requestAnimationFrame: callback => callback(), setTimeout: callback => { callback(); return 1; }, clearTimeout() {},
    setInterval() {}, clearInterval() {}, URLSearchParams,
  });
  return { requests, submittedForms, elements, element, location };
}

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
