# 手机端套餐流程演示

零运行时依赖的 Node.js H5 示例，包含套餐页、购买须知、订单确认、兼职说明、在线客服、管理后台及微信内 JSAPI 支付接入代码。运行环境：Node.js 22 及以上（使用内置 `node:sqlite`）。

## 本地运行

```bash
ADMIN_PASSWORD='请换成强密码' npm start
```

- 手机页面：`http://localhost:3000/`
- 后台：`http://localhost:3000/admin`
- 测试：`npm test`
- 数据保存在 `data/lpay.db`，已加入 `.gitignore`。

默认是**演示模式**：可以选择套餐、创建订单、进入兼职说明及与客服聊天，但不会收取费用。页面没有微信私人聊天已读查询能力；兼职页也不承诺截图中的收益。

## 微信内 JSAPI 支付准备

须先拥有已开通 JSAPI 支付的微信支付商户号，并配置相应公众号、网页授权域名、JSAPI 支付授权目录和 HTTPS 公网地址。将以下环境变量配置在服务器上；私钥与 APIv3 密钥不得放入前端或仓库。

| 变量 | 用途 |
|---|---|
| `ADMIN_PASSWORD` | 后台登录密码，必填 |
| `PUBLIC_BASE_URL` | 公网 HTTPS 地址，如 `https://your-domain.example` |
| `WECHAT_APP_ID` | 已绑定商户号的公众号 AppID |
| `WECHAT_APP_SECRET` | 公众号 AppSecret，用于网页授权获取 OpenID |
| `WECHAT_MCH_ID` | 商户号 |
| `WECHAT_MCH_SERIAL` | 商户 API 证书序列号 |
| `WECHAT_PRIVATE_KEY_PATH` | 商户 API 私钥 PEM 文件路径 |
| `WECHAT_PUBLIC_KEY_PATH` | 微信支付公钥或平台证书 PEM 文件路径，用于验签 |
| `WECHAT_PUBLIC_KEY_ID` | 微信支付公钥 ID；使用公钥模式时设置 |
| `WECHAT_API_V3_KEY` | 32 字节 APIv3 密钥，用于回调解密 |
| `CHECKOUT_ENABLED` | 仅在实际服务可交付且完成支付联调后设为 `1` |
| `SECURE_COOKIES` | 经 HTTPS 对外提供服务时设为 `1`，为访客和后台 Cookie 添加 `Secure` |
| `PORT` | HTTP 端口，默认 `3000` |

当前 VPS 使用 `https://2.25.72.73/` 作为公网入口。`deploy/Caddyfile` 在 80 端口提供证书验证与 HTTPS 跳转，在 443 端口转发到仅绑定服务器回环地址的 Node 容器；`deploy/renew-cert.sh` 由 systemd timer 每天两次检查 IP 证书续期。支付仍由 `CHECKOUT_ENABLED=0` 关闭。

支付流程：浏览器创建本地订单 → `snsapi_base` 网页授权获取 OpenID → 后端调用 JSAPI 下单 → 前端调用 `WeixinJSBridge` 拉起微信官方收银台 → 后端验签并解密微信回调 → 查单确认 → 后台统计成功支付。金额由服务端套餐表决定，客户端传入的金额会被忽略。回调按订单号幂等处理。

上线前应使用自己的真实商品或服务内容更新页面文案和购买须知，完成微信支付商户审核、回调公网联调、对账与退款流程。当前后台为单管理员、单进程会话设计；多实例部署需改用共享会话存储。聊天采用 3–4 秒轮询，适用于小规模客服。
