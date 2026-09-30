import { createHash, timingSafeEqual } from 'node:crypto';

export function zpayConfig() {
  const required = ['ZPAY_PID', 'ZPAY_KEY', 'PUBLIC_BASE_URL'];
  const missing = required.filter(name => !process.env[name]);
  if (missing.length) throw new Error(`Missing ZPAY config: ${missing.join(', ')}`);
  const baseUrl = new URL(process.env.PUBLIC_BASE_URL);
  if (baseUrl.protocol !== 'https:') throw new Error('PUBLIC_BASE_URL must use HTTPS');
  return { pid: process.env.ZPAY_PID, key: process.env.ZPAY_KEY, baseUrl: baseUrl.origin };
}

export function signZpay(fields, key) {
  const data = Object.keys(fields)
    .filter(name => name !== 'sign' && name !== 'sign_type' && fields[name] !== '' && fields[name] != null)
    .sort()
    .map(name => `${name}=${fields[name]}`)
    .join('&');
  return createHash('md5').update(data + key).digest('hex');
}

export function verifyZpay(fields, key) {
  if (fields.sign_type !== 'MD5' || !/^[a-f0-9]{32}$/.test(fields.sign || '')) return false;
  return timingSafeEqual(Buffer.from(signZpay(fields, key), 'hex'), Buffer.from(fields.sign, 'hex'));
}

export function createZpayCheckout(config, order) {
  if (!/^\d{1,32}$/.test(order.orderNo)) throw Object.assign(new Error('旧订单号不支持新支付渠道，请重新创建订单'), { status: 409 });
  const fields = {
    pid: config.pid,
    type: 'wxpay',
    out_trade_no: order.orderNo,
    notify_url: `${config.baseUrl}/api/zpay/notify`,
    return_url: `${config.baseUrl}/api/zpay/return`,
    name: `已读工具-${order.planName}版`,
    money: (order.amountFen / 100).toFixed(2),
  };
  return { action: 'https://zpayz.cn/submit.php', fields: { ...fields, sign: signZpay(fields, config.key), sign_type: 'MD5' } };
}

export async function createZpayWechatCheckout(config, order, clientIp) {
  const pageFields = createZpayCheckout(config, order).fields;
  const fields = {
    pid: pageFields.pid,
    type: pageFields.type,
    out_trade_no: pageFields.out_trade_no,
    notify_url: pageFields.notify_url,
    name: pageFields.name,
    money: pageFields.money,
    clientip: clientIp,
    device: 'mobile',
  };
  const form = new FormData();
  for (const [name, value] of Object.entries({ ...fields, sign: signZpay(fields, config.key), sign_type: 'MD5' })) form.append(name, value);
  const response = await fetch(new URL('/mapi.php', config.apiBaseUrl || 'https://zpayz.cn'), { method: 'POST', body: form, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw Object.assign(new Error('ZPAY 支付接口暂时不可用'), { status: 502 });
  const result = await response.json();
  if (Number(result.code) !== 1 || !result.payurl) throw Object.assign(new Error(result.msg || 'ZPAY 未返回支付地址'), { status: 502 });
  const payurl = new URL(result.payurl);
  if (payurl.protocol !== 'https:' || (payurl.hostname !== 'z-pay.cn' && payurl.hostname !== 'zpayz.cn' && !payurl.hostname.endsWith('.z-pay.cn'))) {
    throw Object.assign(new Error('ZPAY 返回了无效的支付地址'), { status: 502 });
  }
  return { redirectUrl: payurl.toString() };
}

export async function queryZpay(config, orderNo) {
  const url = new URL('/api.php', config.apiBaseUrl || 'https://zpayz.cn');
  url.search = new URLSearchParams({ act: 'order', pid: config.pid, key: config.key, out_trade_no: orderNo }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`ZPAY query HTTP ${response.status}`);
  const result = await response.json();
  return Number(result.code) === 1 && Number(result.status) === 1 ? result : null;
}
