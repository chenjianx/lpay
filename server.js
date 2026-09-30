import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isIP } from 'node:net';
import { createStore } from './store.js';
import { createZpayCheckout, createZpayWechatCheckout, queryZpay, verifyZpay, zpayConfig } from './zpay.js';

const root = dirname(fileURLToPath(import.meta.url));
const staticFiles = { '/': 'index.html', '/order': 'index.html', '/part-time': 'index.html', '/chat': 'index.html', '/admin': 'admin.html', '/app.js': 'app.js', '/admin.js': 'admin.js', '/style.css': 'style.css', '/admin.css': 'admin.css', '/7d5cd45dcd51f003b1f8120b10a805e2.txt': '7d5cd45dcd51f003b1f8120b10a805e2.txt' };
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
const moneyFen = value => {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value || '');
  if (!match) return null;
  const amount = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(amount) ? amount : null;
};
const clientIp = req => {
  const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (peer !== '127.0.0.1' && peer !== '::1') return peer;
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').at(-1).trim();
  return isIP(forwarded) ? forwarded : peer;
};

export function createAppServer({ store, adminPassword = process.env.ADMIN_PASSWORD, checkoutEnabled = process.env.CHECKOUT_ENABLED === '1', secureCookies = process.env.SECURE_COOKIES === '1', zpay }) {
  const sessions = new Map();
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
      if (req.method === 'POST' && path.startsWith('/api/') && req.headers.origin) {
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
        if (order.status === 'PENDING' && /^\d{1,32}$/.test(order.orderNo) && (zpay || (process.env.ZPAY_PID && process.env.ZPAY_KEY))) {
          try {
            const config = zpay || zpayConfig();
            const payment = await queryZpay(config, order.orderNo);
            if (payment && String(payment.pid) === config.pid && payment.out_trade_no === order.orderNo && payment.type === 'wxpay' && moneyFen(payment.money) === order.amountFen && payment.trade_no) {
              order = store.markPaid(order.orderNo, order.amountFen, payment.trade_no);
            }
          } catch { console.error('ZPAY order query failed'); }
        }
        return json(res, 200, order);
      }
      const payMatch = path.match(/^\/api\/orders\/([^/]+)\/pay$/);
      if (req.method === 'POST' && payMatch) {
        const order = ownOrder(payMatch[1]);
        if (!checkoutEnabled) return json(res, 503, { error: '当前暂未开放支付' });
        if (order.status !== 'PENDING') return json(res, 409, { error: '订单无法支付' });
        if (/MicroMessenger/i.test(req.headers['user-agent'] || '')) return json(res, 200, await createZpayWechatCheckout(zpay || zpayConfig(), order, clientIp(req)));
        return json(res, 200, createZpayCheckout(zpay || zpayConfig(), order));
      }
      if (req.method === 'GET' && path === '/api/zpay/notify') {
        const fields = Object.fromEntries(url.searchParams);
        if (url.searchParams.size !== Object.keys(fields).length || !verifyZpay(fields, (zpay || zpayConfig()).key)) return json(res, 401, { error: 'Invalid signature' });
        if (fields.trade_status === 'TRADE_SUCCESS') {
          const order = store.order(fields.out_trade_no);
          const amount = moneyFen(fields.money);
          if (!order || fields.pid !== (zpay || zpayConfig()).pid || fields.type !== 'wxpay' || amount !== order.amountFen || !fields.trade_no || (order.status === 'PAID' && order.transactionId !== fields.trade_no)) return json(res, 400, { error: 'Payment mismatch' });
          store.markPaid(order.orderNo, amount, fields.trade_no);
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('success');
      }
      if (req.method === 'GET' && path === '/api/zpay/return') {
        const orderNo = url.searchParams.get('out_trade_no');
        return redirect(res, orderNo ? `/order?orderNo=${encodeURIComponent(orderNo)}` : '/');
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
        const contentType = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.txt') ? 'text/plain' : 'text/html';
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
