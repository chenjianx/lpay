import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createStore } from './store.js';
import { createPrepay, decryptNotification, exchangeOAuthCode, queryPayment, verifyWechatSignature, wechatConfig } from './wechat.js';

const root = dirname(fileURLToPath(import.meta.url));
const staticFiles = { '/': 'index.html', '/order': 'index.html', '/part-time': 'index.html', '/chat': 'index.html', '/admin': 'admin.html', '/app.js': 'app.js', '/admin.js': 'admin.js', '/style.css': 'style.css', '/admin.css': 'admin.css' };
const json = (res, status, data, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(data)); };
const redirect = (res, location, headers = {}) => { res.writeHead(302, { Location: location, ...headers }); res.end(); };
const getCookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=').map(decodeURIComponent)).filter(x => x.length === 2));
const token = () => randomBytes(24).toString('hex');
const safeEqual = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
const bodyText = async req => {
  let value = '';
  for await (const chunk of req) { value += chunk; if (value.length > 32_000) throw new Error('Request too large'); }
  return value;
};
const bodyJson = async req => JSON.parse(await bodyText(req));

export function createAppServer({ store, adminPassword = process.env.ADMIN_PASSWORD, checkoutEnabled = process.env.CHECKOUT_ENABLED === '1', secureCookies = process.env.SECURE_COOKIES === '1' }) {
  const sessions = new Map();
  const oauthStates = new Map();
  const failedLogins = new Map();
  const cookieSecure = secureCookies ? '; Secure' : '';
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const cookies = getCookies(req);
    let visitorId = /^[a-f0-9]{48}$/.test(cookies.visitor || '') ? cookies.visitor : token();
    if (visitorId !== cookies.visitor) res.setHeader('Set-Cookie', `visitor=${visitorId}; Path=/; HttpOnly${cookieSecure}; SameSite=Lax; Max-Age=31536000`);
    const admin = sessions.get(cookies.admin)?.expires > Date.now();
    const ownOrder = orderNo => { const order = store.order(orderNo); if (!order) throw Object.assign(new Error('Order not found'), { status: 404 }); if (order.visitorId !== visitorId) throw Object.assign(new Error('Forbidden'), { status: 403 }); return order; };
    const requireAdmin = () => { if (!admin) throw Object.assign(new Error('Login required'), { status: 401 }); };
    try {
      if (req.method === 'POST' && path.startsWith('/api/') && path !== '/api/wechat/notify' && req.headers.origin) {
        const origin = new URL(req.headers.origin);
        if (origin.host !== req.headers.host) throw Object.assign(new Error('Invalid origin'), { status: 403 });
      }
      if (req.method === 'GET' && path === '/api/session') return json(res, 200, { checkoutEnabled });
      if (req.method === 'POST' && path === '/api/events') {
        const { type, target } = await bodyJson(req);
        store.recordEvent(visitorId, type, target);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/orders') {
        const { planId } = await bodyJson(req);
        return json(res, 201, store.createOrder(planId, visitorId));
      }
      const orderMatch = path.match(/^\/api\/orders\/([^/]+)$/);
      if (req.method === 'GET' && orderMatch) {
        let order = ownOrder(orderMatch[1]);
        if (checkoutEnabled && order.status === 'PENDING' && order.openid) {
          try { const result = await queryPayment(wechatConfig(), order.orderNo); if (result.trade_state === 'SUCCESS' && result.amount?.total === order.amountFen) order = store.markPaid(order.orderNo, result.amount.total, result.transaction_id, result.success_time); } catch (error) { console.error('Order query:', error.message); }
        }
        return json(res, 200, order);
      }
      const payMatch = path.match(/^\/api\/orders\/([^/]+)\/pay$/);
      if (req.method === 'POST' && payMatch) {
        const order = ownOrder(payMatch[1]);
        if (!checkoutEnabled) return json(res, 503, { error: '当前暂未开放支付' });
        if (order.status !== 'PENDING') return json(res, 409, { error: '订单无法支付' });
        const config = wechatConfig();
        if (!order.openid) {
          const state = token();
          oauthStates.set(state, { orderNo: order.orderNo, visitorId, expires: Date.now() + 5 * 60_000 });
          const callback = encodeURIComponent(`${config.baseUrl}/api/wechat/oauth/callback`);
          return json(res, 200, { oauthUrl: `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${encodeURIComponent(config.appid)}&redirect_uri=${callback}&response_type=code&scope=snsapi_base&state=${state}#wechat_redirect` });
        }
        return json(res, 200, { payment: await createPrepay(config, order) });
      }
      if (req.method === 'GET' && path === '/api/wechat/oauth/callback') {
        const state = oauthStates.get(url.searchParams.get('state'));
        oauthStates.delete(url.searchParams.get('state'));
        if (!state || state.expires < Date.now() || state.visitorId !== visitorId || !url.searchParams.get('code')) return json(res, 400, { error: '授权状态已过期，请重新下单' });
        const openid = await exchangeOAuthCode(wechatConfig(), url.searchParams.get('code'));
        store.setOpenid(state.orderNo, openid);
        return redirect(res, `/order?orderNo=${encodeURIComponent(state.orderNo)}&pay=1`);
      }
      if (req.method === 'POST' && path === '/api/wechat/notify') {
        const raw = await bodyText(req);
        const config = wechatConfig();
        const timestamp = req.headers['wechatpay-timestamp'];
        const signature = req.headers['wechatpay-signature'];
        const serial = req.headers['wechatpay-serial'];
        if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || (config.publicKeyId && serial !== config.publicKeyId) || !verifyWechatSignature({ timestamp, nonce: req.headers['wechatpay-nonce'], body: raw, signature, publicKey: config.publicKey })) return json(res, 401, { error: 'Invalid signature' });
        const notification = JSON.parse(raw);
        if (notification.event_type !== 'TRANSACTION.SUCCESS') return json(res, 200, { code: 'SUCCESS' });
        const payment = decryptNotification(notification.resource, config.apiV3Key);
        const order = store.order(payment.out_trade_no);
        if (!order || payment.mchid !== config.mchid || payment.appid !== config.appid || payment.trade_state !== 'SUCCESS' || payment.amount?.total !== order.amountFen) return json(res, 400, { error: 'Payment mismatch' });
        store.markPaid(order.orderNo, payment.amount.total, payment.transaction_id, payment.success_time);
        return json(res, 200, { code: 'SUCCESS' });
      }
      if (req.method === 'GET' && path === '/api/chat/messages') return json(res, 200, store.messages(visitorId, Number(url.searchParams.get('after') || 0)));
      if (req.method === 'POST' && path === '/api/chat/messages') return json(res, 201, store.addMessage(visitorId, 'visitor', (await bodyJson(req)).body));
      if (req.method === 'POST' && path === '/api/admin/login') {
        const ip = req.socket.remoteAddress || 'unknown';
        const failures = failedLogins.get(ip) || 0;
        if (failures >= 10) return json(res, 429, { error: '尝试次数过多，请稍后再试' });
        const password = (await bodyJson(req)).password || '';
        if (!adminPassword || !safeEqual(password, adminPassword)) { failedLogins.set(ip, failures + 1); return json(res, 401, { error: '密码错误' }); }
        failedLogins.delete(ip);
        const session = token();
        sessions.set(session, { expires: Date.now() + 12 * 3600_000 });
        return json(res, 200, { ok: true }, { 'Set-Cookie': `admin=${session}; Path=/; HttpOnly${cookieSecure}; SameSite=Strict; Max-Age=43200` });
      }
      if (req.method === 'POST' && path === '/api/admin/logout') { sessions.delete(cookies.admin); return json(res, 200, { ok: true }, { 'Set-Cookie': `admin=; Path=/; HttpOnly${cookieSecure}; Max-Age=0` }); }
      if (path.startsWith('/api/admin/')) {
        requireAdmin();
        if (req.method === 'GET' && path === '/api/admin/stats') return json(res, 200, store.stats());
        if (req.method === 'GET' && path === '/api/admin/orders') return json(res, 200, store.orders());
        if (req.method === 'GET' && path === '/api/admin/events') return json(res, 200, store.recentEvents());
        if (req.method === 'GET' && path === '/api/admin/conversations') return json(res, 200, store.conversations());
        if (req.method === 'GET' && path === '/api/admin/messages') return json(res, 200, store.messages(url.searchParams.get('visitorId') || ''));
        if (req.method === 'POST' && path === '/api/admin/messages') { const data = await bodyJson(req); return json(res, 201, store.addMessage(data.visitorId, 'staff', data.body)); }
      }
      if (req.method === 'GET' && staticFiles[path]) {
        const file = join(root, 'public', staticFiles[path]);
        const contentType = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
        res.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8` });
        return res.end(readFileSync(file));
      }
      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      const status = error.status || (error instanceof SyntaxError || /Invalid|mismatch|too large/.test(error.message) ? 400 : 500);
      if (status === 500) console.error(error);
      return json(res, status, { error: status === 500 ? '服务器暂时无法处理请求' : error.message });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(join(root, 'data'), { recursive: true });
  const store = createStore(join(root, 'data', 'lpay.db'));
  const port = Number(process.env.PORT || 3000);
  createAppServer({ store }).listen(port, () => console.log(`Listening on http://localhost:${port}`));
}
