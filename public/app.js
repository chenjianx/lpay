const app = document.querySelector('#app');
const toast = document.querySelector('#toast');
const path = location.pathname;
let session = { checkoutEnabled: false };
let selectedPlan = 'forever';
let chatTimer;

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
function showToast(message) { toast.textContent = message; toast.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('show'), 3000); }
function track(type, target) { request('/api/events', { method: 'POST', body: JSON.stringify({ type, target }) }).catch(() => {}); }
function setPaymentLoading(button, loading) {
  if (loading) button.dataset.paymentLabel = button.textContent;
  else { button.textContent = button.dataset.paymentLabel; delete button.dataset.paymentLabel; }
  button.disabled = loading;
  if (loading) button.textContent = '正在跳转支付…';
  button.classList[loading ? 'add' : 'remove']('payment-pending');
  if (loading) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
}
async function startPayment(orderNo) {
  const result = await request(`/api/orders/${encodeURIComponent(orderNo)}/pay`, { method:'POST' });
  if (result.redirectUrl) { location.href = result.redirectUrl; return; }
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = result.action;
  form.hidden = true;
  for (const [name, value] of Object.entries(result.fields)) {
    const input = document.createElement('input');
    input.type = 'hidden'; input.name = name; input.value = value;
    form.append(input);
  }
  document.body.append(form);
  form.submit();
}
function button(id, label, className = 'primary') { return `<button id="${id}" class="${className}">${label}</button>`; }
function renderLoading() {
  app.innerHTML = `<section class="loading-screen" aria-label="正在加载页面"><div class="loading-content"><div class="loading-icon" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M6 21 24 7l18 14" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 22v18h18V25l-3-3-8 7-7-7Z" fill="currentColor"/><rect x="28" y="23" width="14" height="21" rx="3" fill="currentColor"/><path d="M33 29h4m-4 6h4" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg></div><h1>正在打开消息已读工具</h1><p>正在载入页面资源</p><div class="loading-bar" role="progressbar" aria-label="页面加载进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="8"><span id="loadProgress"></span></div><p class="loading-status">已读工具初始化中...</p></div><span class="loading-version">已读 · 版本 1.0.0</span></section>`;
  requestAnimationFrame(() => { const bar = document.querySelector('#loadProgress'); if (bar) { bar.style.width = '88%'; bar.parentElement.setAttribute('aria-valuenow', '88'); } });
}
function modal(title, content) {
  const overlay = document.createElement('div'); overlay.className = 'overlay';
  overlay.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="sheet-head"><span>${title}</span><button aria-label="关闭">×</button></div><div class="sheet-body">${content}</div>${button('sheetAgree','我已了解并同意')}</div>`;
  document.body.append(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('.sheet-head button').onclick = close;
  overlay.querySelector('#sheetAgree').onclick = close;
}
const terms = `<p>1. 本工具为第三方独立开发，与微信官方无任何关联。</p><p>2. 创建订单后，页面会显示订单编号和金额；实际付款以支付收银台的信息为准。</p><p>3. 付款成功后，请通过在线客服提交订单编号，服务由人工交付，不会自动开通。</p><p>4. 如需申请退款，请通过在线客服提供订单编号，由客服按订单情况处理。</p><p>5. 请在合法合规场景下使用，不得用于骚扰、诈骗等违法行为。</p><p>6. 如有疑问，请通过页面内的在线聊天联系客服。</p>`;
function planMarkup(id, title, tag, desc, extra, price, featured = false) {
  return `<button class="plan ${featured ? 'featured' : ''} ${selectedPlan === id ? 'selected' : ''}" data-plan="${id}" aria-pressed="${selectedPlan === id}">${featured ? '<span class="recommend">♛ 推荐 · 尊享首选</span>' : ''}<span class="radio">${selectedPlan === id ? '✓' : ''}</span><span class="plan-body"><span class="plan-title"><strong>${title}</strong><span class="pill ${featured ? 'red' : ''}">${tag}</span></span><span class="plan-desc">${desc}</span>${extra ? `<span class="plan-extra">${extra}</span>` : ''}</span><span class="plan-price"><small>¥</small>${price}</span>${featured ? '<span class="benefits"><span><i>✓</i> 永久免费更新</span><span><i>✓</i> 24小时在线售后</span><span><i>✓</i> 最新功能体验</span></span>' : ''}</button>`;
}
function renderHome() {
  app.innerHTML = `<div class="screen"><div class="notice"><span class="info-icon">i</span><div><b>须知：</b>通过卡片消息用户点击获取已读状态；付款后凭订单号联系客服，由人工交付</div></div><div class="section-heading"><h1>选择服务套餐</h1><span>请选择适合的套餐</span></div><div id="plans"></div><button id="refund" class="refund">若无法查看可联系客服申请退款</button><div class="fineprint"><p>· 此工具为第三方独立工具，与微信官方无关联。</p><p>· 购买前请详细阅读《购买须知》，了解服务内容及退款规则。</p></div></div><div class="fixed-bottom"><div class="bottom-inner"><label class="agree"><input id="agree" type="checkbox"><span>点击支付即同意</span><button id="agreement">《用户服务协议》</button><button id="purchaseNotice">《购买须知》</button></label><div class="actions">${button('buy','立即下单')}${button('partTime','兼职赚佣金','orange')}</div><div class="version">已读 · 版本 1.0.0</div></div></div>`;
  const plans = document.querySelector('#plans');
  const fillPlans = () => {
    plans.innerHTML = planMarkup('month','一个月','体验套餐','不用再猜！发完消息立刻知道对方看没看','','9.99') + planMarkup('year','一年','性价比高','长期使用更划算！全年不用再等消息回执','省 ¥45.95 | 折合月均成本更低','13.99') + planMarkup('forever','永久','热销套餐','永久使用！再也不用纠结“为啥不回我”','省 ¥339.65 | 已有 999+ 用户购买','19.99',true);
    plans.querySelectorAll('[data-plan]').forEach(el => el.onclick = () => { selectedPlan = el.dataset.plan; fillPlans(); track('click', `plan_${selectedPlan}`); });
  };
  fillPlans();
  document.querySelector('#refund').onclick = () => modal('《购买须知》', terms);
  document.querySelector('#agreement').onclick = () => modal('用户服务协议', terms);
  document.querySelector('#purchaseNotice').onclick = () => modal('《购买须知》', terms);
  document.querySelector('#partTime').onclick = () => { track('click','part_time'); location.href = '/part-time'; };
  const buyButton = document.querySelector('#buy');
  buyButton.onclick = async () => {
    if (buyButton.disabled) return;
    track('click','buy');
    if (!document.querySelector('#agree').checked) return showToast('请先阅读并同意购买须知');
    setPaymentLoading(buyButton, true);
    try {
      const order = await request('/api/orders', { method: 'POST', body: JSON.stringify({ planId: selectedPlan }) });
      if (!session.checkoutEnabled) { location.href = `/order?orderNo=${encodeURIComponent(order.orderNo)}`; return; }
      await startPayment(order.orderNo);
    }
    catch (error) { setPaymentLoading(buyButton, false); showToast(error.message); }
  };
}

function renderPartTime() {
  app.innerHTML = `<div class="part-time-nav"><a href="/">〈 返回</a><strong>兼职任务中心</strong></div><div class="screen"><h1 class="page-title">正规合作 · 轻松赚佣金</h1><div class="white-card"><h2>合作说明</h2><p>提供<span class="blue">产品视频 / 文案</span>，保存后发布到抖音、快手。</p><div class="checkline"><span><i>✓</i> 全程免费</span><span><i>✓</i> 无需经验</span><span><i>✓</i> 当日结算</span></div></div><div class="white-card"><h2>收益说明</h2><div class="earnings"><div>发布成功 <b>1 元/条</b></div><div>播放 1 万 <b>+3 元</b></div><div>播放 6 万 <b>+16.66 元</b></div><div>播放 10 万 <b>+26.66 元</b></div></div><div class="earning-note">满 30 天额外 <b>1000 元</b> · 日发 3~5 条约 <b>20~50 元</b></div></div><div class="white-card"><h2>操作流程</h2><div class="steps"><p><b>1.</b> 点页面底部按钮，发送「我要兼职赚佣金」</p><p><b>2.</b> 发布到抖音 / 快手，截图与链接发给客服</p><p><b>3.</b> 提供收款码，<span class="green">当日结算</span></p></div></div></div><div class="fixed-bottom"><div class="bottom-inner">${button('contact','立即联系客服','orange')}<div class="version">✓ 已解锁 · v1.0.0</div></div></div>`;
  document.querySelector('#contact').onclick = () => { track('click','contact_service'); location.href = '/chat'; };
}

function displayTime(value) { return value ? new Date(new Date(value).getTime() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ') : '—'; }
async function renderOrder() {
  document.title = '订单确认';
  document.querySelector('.site-header strong').textContent = '订单确认';
  const orderNo = new URLSearchParams(location.search).get('orderNo');
  if (!orderNo) { location.href = '/'; return; }
  app.innerHTML = '<div class="screen"><p class="muted">正在加载订单…</p></div>';
  try {
    const order = await request(`/api/orders/${encodeURIComponent(orderNo)}`);
    app.innerHTML = `<div class="screen"><div class="order-band"></div><div class="order-card"><h1>订单确认</h1><div class="order-row"><span>订单名称：</span><strong id="orderName"></strong></div><div class="order-row"><span>订单金额：</span><strong class="amount" id="orderAmount"></strong></div><div class="order-row"><span>订单编号：</span><strong id="orderNo"></strong></div><div class="order-row"><span>创建时间：</span><strong id="createdAt"></strong></div>${button('pay',session.checkoutEnabled ? '支付' : '支付暂未开通')}<p class="order-status" id="orderStatus" hidden></p><p class="muted">付款将跳转至 ZPAY 收银台，请核对金额。付款后请<a href="/chat">联系客服并提供订单号</a>，服务由人工交付。此页面不收集支付密码。</p></div></div>`;
    document.querySelector('#orderName').textContent = `已读工具-${order.planName}版`;
    document.querySelector('#orderAmount').textContent = `¥${(order.amountFen / 100).toFixed(2)}`;
    document.querySelector('#orderNo').textContent = order.orderNo;
    document.querySelector('#createdAt').textContent = displayTime(order.createdAt);
    if (order.status === 'PAID') { document.querySelector('#orderStatus').hidden = false; document.querySelector('#orderStatus').textContent = `已支付 · ${displayTime(order.paidAt)}`; document.querySelector('#pay').disabled = true; document.querySelector('#pay').textContent = '已支付'; }
    const payButton = document.querySelector('#pay');
    payButton.onclick = async () => {
      if (payButton.disabled) return;
      track('click','pay');
      if (!session.checkoutEnabled) return showToast('当前暂未开放支付');
      setPaymentLoading(payButton, true);
      try { await startPayment(orderNo); } catch (error) { setPaymentLoading(payButton, false); showToast(error.message); }
    };
  } catch (error) { app.innerHTML = `<div class="screen"><p class="muted">订单无法打开：${error.message}</p><a href="/">返回首页</a></div>`; }
}
function messageBubble(message) {
  const bubble = document.createElement('div'); bubble.className = `bubble ${message.sender === 'visitor' ? 'mine' : ''}`;
  const content = document.createElement('div'); content.textContent = message.body; bubble.append(content);
  const time = document.createElement('small'); time.textContent = displayTime(message.created_at); bubble.append(time);
  return bubble;
}
function renderChat() {
  document.title = '在线客服';
  document.querySelector('.site-header strong').textContent = '在线客服';
  app.innerHTML = `<div class="screen"><div class="notice"><span class="info-icon">i</span><div>在线客服 · 留言后可在本页面查看回复</div></div><div id="chatMessages" class="chat-messages"></div></div><form id="chatForm" class="chat-form"><input name="message" maxlength="2000" placeholder="输入消息" aria-label="输入消息" required><button>发送</button></form>`;
  let after = 0;
  const load = async () => {
    try {
      const messages = await request(`/api/chat/messages?after=${after}`);
      const list = document.querySelector('#chatMessages');
      messages.forEach(message => { list.append(messageBubble(message)); after = message.id; });
      if (messages.length) list.scrollTop = list.scrollHeight;
    } catch { /* retry next poll */ }
  };
  load(); chatTimer = setInterval(load, 3000);
  document.querySelector('#chatForm').onsubmit = async e => {
    e.preventDefault();
    const input = e.currentTarget.elements.message;
    const body = input.value.trim(); if (!body) return;
    try { await request('/api/chat/messages', { method:'POST', body:JSON.stringify({ body }) }); input.value = ''; track('click','chat_send'); load(); }
    catch (error) { showToast(error.message); }
  };
}

document.querySelector('#siteAddress').textContent = location.host;
if (/MicroMessenger/i.test(navigator.userAgent)) document.documentElement.classList.add('wechat-browser');
document.querySelector('#backButton').onclick = () => { if (path === '/') history.back(); else location.href = path === '/chat' ? '/part-time' : '/'; };
document.querySelector('#moreButton').onclick = () => modal('页面说明', terms);
const loadingDelay = path === '/' ? new Promise(resolve => setTimeout(resolve, 1500)) : null;
if (loadingDelay) renderLoading();
try { session = await request('/api/session'); } catch { showToast('无法连接服务端'); }
if (loadingDelay) {
  await loadingDelay;
  const bar = document.querySelector('#loadProgress');
  bar.style.width = '100%';
  bar.parentElement.setAttribute('aria-valuenow', '100');
  await new Promise(resolve => setTimeout(resolve, 180));
}
track('page_view', path);
if (path === '/part-time') renderPartTime(); else if (path === '/order') renderOrder(); else if (path === '/chat') renderChat(); else renderHome();
window.addEventListener('pagehide', () => clearInterval(chatTimer));
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  const buyButton = document.querySelector('#buy');
  if (buyButton?.classList.contains('payment-pending')) setPaymentLoading(buyButton, false);
  const payButton = document.querySelector('#pay');
  if (payButton?.classList.contains('payment-pending')) setPaymentLoading(payButton, false);
});
