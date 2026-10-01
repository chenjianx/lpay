# 手机端套餐流程演示

零运行时依赖的 Node.js H5 示例，包含套餐页、购买须知、订单确认、兼职说明、在线客服、管理后台及 ZPAY 支付接入代码。运行环境：Node.js 22.9 及以上（使用内置 `node:sqlite`）。

## 本地运行

```bash
ADMIN_PASSWORD='请换成强密码' npm start
```

- 手机页面：`http://localhost:3000/`
- 后台：`http://localhost:3000/admin`
- 测试：`npm test`
- 数据保存在 `data/lpay.db`，已加入 `.gitignore`。
- `npm start` 会读取项目根目录中可选的 `.env`；该文件已被 Git 忽略。已有进程需重启才能读取新配置。

默认是**演示模式**：可以选择套餐、创建订单、进入兼职说明及与客服聊天，但不会收取费用。页面没有微信私人聊天已读查询能力；兼职页也不承诺截图中的收益。

## ZPAY 支付准备

先在 ZPAY 开通微信支付渠道，从会员中心“支付渠道 → API安全”取得商户 ID 和商户密钥，并确认公网 HTTPS 地址可供 ZPAY 回调。将以下环境变量配置在服务器上；商户密钥不得放入前端或仓库。

| 变量 | 用途 |
|---|---|
| `ADMIN_PASSWORD` | 后台登录密码，必填 |
| `PUBLIC_BASE_URL` | 公网 HTTPS 地址，如 `https://your-domain.example` |
| `ZPAY_PID` | ZPAY 商户 ID |
| `ZPAY_KEY` | ZPAY 商户密钥，仅供服务端签名与查单 |
| `CHECKOUT_ENABLED` | 仅在实际服务可交付且完成支付联调后设为 `1` |
| `SECURE_COOKIES` | 经 HTTPS 对外提供服务时设为 `1`，为访客和后台 Cookie 添加 `Secure` |
| `PORT` | HTTP 端口，默认 `3000` |

阿里云公网入口为 `https://47-82-81-0.sslip.io/`，`http://47.82.81.0/` 会跳转到该 HTTPS 地址。`deploy/Caddyfile` 将请求转发到本机 `127.0.0.1:13000`，由 Caddy 自动管理 HTTPS 证书。阿里云上的 Node 服务由 `lpay.service` 运行，工作目录为 `/opt/lpay`。该服务器的 `PUBLIC_BASE_URL` 应设为 `https://47-82-81-0.sslip.io`，并与商户后台允许的回调地址一致；ZPAY 将请求 `${PUBLIC_BASE_URL}/api/zpay/notify`，页面跳转支付完成后浏览器将打开 `${PUBLIC_BASE_URL}/api/zpay/return`。收款状态由 `CHECKOUT_ENABLED` 控制。`deploy/renew-cert.sh` 和对应 timer/service 是旧主机的证书续期配置，阿里云不使用。

支付流程：浏览器创建本地订单 → 后端按服务端套餐金额生成 ZPAY 签名。普通微信内的网页由后端调用 ZPAY `/mapi.php`，浏览器打开返回的 `payurl`，再由 ZPAY 页面完成微信授权及调起支付；其他浏览器继续 POST 到 ZPAY 收银台。ZPAY 请求 `GET /api/zpay/notify` 后，后端验签、核对商户号/订单号/金额并幂等入账。页面跳转支付返回 `GET /api/zpay/return` 仅跳转订单页；订单页会通过 ZPAY 查单接口补偿遗漏的通知。客户端传入的金额会被忽略。旧版以 `RP` 开头的订单号不能用于 ZPAY 支付，需重新创建数字订单号。微信内直调仍需用真实微信客户端验证授权、支付和回调。

上线前应使用真实、可交付的商品或服务内容更新页面文案和购买须知，完成 ZPAY 渠道审核、回调公网联调、对账与退款流程。在提供真实服务并完成联调前保持 `CHECKOUT_ENABLED=0`。当前后台为单管理员、单进程会话设计；多实例部署需改用共享会话存储。聊天采用 3–4 秒轮询，适用于小规模客服。
