import { createDecipheriv, randomBytes, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const nonce = () => randomBytes(16).toString('hex');
const rsaSign = (message, privateKey) => sign('RSA-SHA256', Buffer.from(message), privateKey).toString('base64');

export function jsapiParameters(appid, prepayId, privateKey) {
  const timeStamp = String(Math.floor(Date.now() / 1000));
  const nonceStr = nonce();
  const pkg = `prepay_id=${prepayId}`;
  return { appId: appid, timeStamp, nonceStr, package: pkg, signType: 'RSA', paySign: rsaSign(`${appid}\n${timeStamp}\n${nonceStr}\n${pkg}\n`, privateKey) };
}

export function verifyWechatSignature({ timestamp, nonce: requestNonce, body, signature, publicKey }) {
  if (!timestamp || !requestNonce || !signature || !publicKey) return false;
  try { return verify('RSA-SHA256', Buffer.from(`${timestamp}\n${requestNonce}\n${body}\n`), publicKey, Buffer.from(signature, 'base64')); }
  catch { return false; }
}

export function decryptNotification(resource, apiV3Key) {
  const bytes = Buffer.from(resource.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(resource.nonce));
  decipher.setAAD(Buffer.from(resource.associated_data || ''));
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString());
}

export function wechatConfig() {
  const required = ['WECHAT_APP_ID', 'WECHAT_APP_SECRET', 'WECHAT_MCH_ID', 'WECHAT_MCH_SERIAL', 'WECHAT_PRIVATE_KEY_PATH', 'WECHAT_PUBLIC_KEY_PATH', 'WECHAT_API_V3_KEY', 'PUBLIC_BASE_URL'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length) throw new Error(`Missing WeChat config: ${missing.join(', ')}`);
  return {
    appid: process.env.WECHAT_APP_ID, appSecret: process.env.WECHAT_APP_SECRET, mchid: process.env.WECHAT_MCH_ID,
    serial: process.env.WECHAT_MCH_SERIAL, privateKey: readFileSync(process.env.WECHAT_PRIVATE_KEY_PATH),
    publicKey: readFileSync(process.env.WECHAT_PUBLIC_KEY_PATH), publicKeyId: process.env.WECHAT_PUBLIC_KEY_ID,
    apiV3Key: process.env.WECHAT_API_V3_KEY, baseUrl: process.env.PUBLIC_BASE_URL.replace(/\/$/, ''),
  };
}

async function apiRequest(config, method, path, body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const requestNonce = nonce();
  const payload = body === undefined ? '' : JSON.stringify(body);
  const signature = rsaSign(`${method}\n${path}\n${timestamp}\n${requestNonce}\n${payload}\n`, config.privateKey);
  const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchid}",nonce_str="${requestNonce}",timestamp="${timestamp}",serial_no="${config.serial}",signature="${signature}"`;
  const response = await fetch(`https://api.mch.weixin.qq.com${path}`, { method, headers: { Authorization: authorization, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : payload });
  const text = await response.text();
  if (!response.ok) throw new Error(`WeChat API ${response.status}: ${text.slice(0, 300)}`);
  if ((config.publicKeyId && response.headers.get('wechatpay-serial') !== config.publicKeyId) || !verifyWechatSignature({ timestamp: response.headers.get('wechatpay-timestamp'), nonce: response.headers.get('wechatpay-nonce'), body: text, signature: response.headers.get('wechatpay-signature'), publicKey: config.publicKey })) throw new Error('Invalid WeChat response signature');
  return JSON.parse(text);
}

export async function createPrepay(config, order) {
  const result = await apiRequest(config, 'POST', '/v3/pay/transactions/jsapi', { appid: config.appid, mchid: config.mchid, description: `已读工具-${order.planName}版`, out_trade_no: order.orderNo, notify_url: `${config.baseUrl}/api/wechat/notify`, amount: { total: order.amountFen, currency: 'CNY' }, payer: { openid: order.openid } });
  return jsapiParameters(config.appid, result.prepay_id, config.privateKey);
}

export async function queryPayment(config, orderNo) {
  return apiRequest(config, 'GET', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}?mchid=${encodeURIComponent(config.mchid)}`);
}

export async function exchangeOAuthCode(config, code) {
  const params = new URLSearchParams({ appid: config.appid, secret: config.appSecret, code, grant_type: 'authorization_code' });
  const response = await fetch(`https://api.weixin.qq.com/sns/oauth2/access_token?${params}`);
  const result = await response.json();
  if (!result.openid) throw new Error(`OAuth failed: ${result.errcode || 'unknown'}`);
  return result.openid;
}
