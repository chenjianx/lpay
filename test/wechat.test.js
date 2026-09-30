import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, generateKeyPairSync, sign, verify } from 'node:crypto';
import { jsapiParameters, decryptNotification, verifyWechatSignature, createPrepay } from '../wechat.js';

test('JSAPI parameters have a valid RSA signature', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const params = jsapiParameters('app-id', 'prepay-id', privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const message = `app-id\n${params.timeStamp}\n${params.nonceStr}\n${params.package}\n`;
  assert.equal(params.package, 'prepay_id=prepay-id');
  assert.equal(verify('RSA-SHA256', Buffer.from(message), publicKey, Buffer.from(params.paySign, 'base64')), true);
});

test('payment notification requires a valid signature and decrypts resource', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = '12345678901234567890123456789012';
  const safeNonce = '123456789012';
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(safeNonce));
  cipher.setAAD(Buffer.from('associated'));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ out_trade_no: 'o1' })), cipher.final(), cipher.getAuthTag()]);
  const resource = { nonce: safeNonce, associated_data: 'associated', ciphertext: encrypted.toString('base64') };
  assert.equal(decryptNotification(resource, key).out_trade_no, 'o1');
  const body = JSON.stringify({ resource });
  const timestamp = '123';
  const requestNonce = 'abc';
  const signature = sign('RSA-SHA256', Buffer.from(`${timestamp}\n${requestNonce}\n${body}\n`), privateKey).toString('base64');
  assert.equal(verifyWechatSignature({ timestamp, nonce: requestNonce, body, signature, publicKey }), true);
  assert.equal(verifyWechatSignature({ timestamp, nonce: requestNonce, body: body + 'x', signature, publicKey }), false);
});

test('prepay rejects an unsigned WeChat API response', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const originalFetch = globalThis.fetch;
  let description;
  globalThis.fetch = async (_url, options) => {
    description = JSON.parse(options.body).description;
    return new Response(JSON.stringify({ prepay_id: 'fake' }), { status: 200 });
  };
  try {
    await assert.rejects(createPrepay({ appid:'app', mchid:'mch', serial:'serial', privateKey:privateKey.export({ type:'pkcs8', format:'pem' }), publicKey:publicKey.export({ type:'spki', format:'pem' }), baseUrl:'https://example.com' }, { orderNo:'order', planName:'一年', amountFen:1399, openid:'openid' }), /signature/i);
    assert.equal(description, '已读工具-一年版');
  } finally { globalThis.fetch = originalFetch; }
});
