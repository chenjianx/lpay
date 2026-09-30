const app = document.querySelector('#adminApp');
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const money = fen => `¥${(fen / 100).toFixed(2)}`;
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12:false }) : '—';
let activeVisitor = '';
let timer;
async function api(url, options = {}) {
  const response = await fetch(url, { credentials:'same-origin', headers:{ 'Content-Type':'application/json' }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
function loginScreen(message = '') {
  clearInterval(timer);
  app.innerHTML = `<div class="login-wrap"><form class="login" id="login"><h1>管理后台</h1><p>请输入管理员密码继续</p><input type="password" name="password" required autocomplete="current-password" placeholder="管理员密码"><button>登录</button><div class="error">${esc(message)}</div></form></div>`;
  document.querySelector('#login').onsubmit = async e => {
    e.preventDefault();
    try { await api('/api/admin/login', { method:'POST', body:JSON.stringify({ password:e.currentTarget.elements.password.value }) }); dashboard(); }
    catch (error) { loginScreen(error.message); }
  };
}
function dashboardShell() {
  app.innerHTML = `<div class="layout"><header class="topbar"><div><h1>运营管理</h1><p>访问、订单、收款与在线客服</p></div><button id="logout">退出登录</button></header><div id="metrics" class="metrics"></div><div class="columns"><div><section class="panel"><div class="panel-head"><h2>最近订单</h2><button class="small-button" id="refresh">刷新</button></div><div class="scroll"><table><thead><tr><th>订单号</th><th>套餐</th><th>金额</th><th>状态</th><th>支付时间</th></tr></thead><tbody id="orders"></tbody></table></div></section><section class="panel"><div class="panel-head"><h2>最近访问与点击</h2></div><div class="scroll"><table><thead><tr><th>时间</th><th>事件</th><th>位置</th><th>访客</th></tr></thead><tbody id="events"></tbody></table></div></section></div><section class="panel"><div class="panel-head"><h2>在线客服</h2></div><div class="panel-body"><div id="conversations" class="conversation-list"></div><div id="messages" class="chat-list"><span class="empty">选择一个会话查看消息</span></div><form id="reply" class="reply"><input name="body" maxlength="2000" placeholder="回复消息" aria-label="回复消息" required><button>发送</button></form></div></section></div></div>`;
  document.querySelector('#logout').onclick = async () => { await api('/api/admin/logout', { method:'POST' }); loginScreen(); };
  document.querySelector('#refresh').onclick = refresh;
  document.querySelector('#reply').onsubmit = async e => {
    e.preventDefault();
    if (!activeVisitor) return;
    const input = e.currentTarget.elements.body;
    try { await api('/api/admin/messages', { method:'POST', body:JSON.stringify({ visitorId:activeVisitor, body:input.value }) }); input.value = ''; await loadMessages(); }
    catch (error) { alert(error.message); }
  };
}
async function loadMessages() {
  if (!activeVisitor) return;
  const messages = await api(`/api/admin/messages?visitorId=${encodeURIComponent(activeVisitor)}`);
  const list = document.querySelector('#messages');
  list.innerHTML = messages.map(message => `<div class="chat-msg ${message.sender === 'staff' ? 'staff' : ''}">${esc(message.body)}<small>${esc(time(message.created_at))}</small></div>`).join('') || '<span class="empty">暂无消息</span>';
  list.scrollTop = list.scrollHeight;
}
async function refresh() {
  try {
    const [stats, orders, events, conversations] = await Promise.all([api('/api/admin/stats'), api('/api/admin/orders'), api('/api/admin/events'), api('/api/admin/conversations')]);
    const cards = [['访问量 PV',stats.pageViews],['访客数 UV',stats.visitors],['点击量',stats.clicks],['成功支付',stats.payments.count],['总收款',money(stats.payments.totalFen)]];
    document.querySelector('#metrics').innerHTML = cards.map(([label,value]) => `<div class="metric"><span>${label}</span><strong>${esc(value)}</strong></div>`).join('');
    document.querySelector('#orders').innerHTML = orders.map(order => `<tr><td>${esc(order.orderNo)}</td><td>${esc(order.planName)}</td><td>${esc(money(order.amountFen))}</td><td><span class="tag ${order.status === 'PAID' ? 'paid' : ''}">${order.status === 'PAID' ? '已支付' : '待支付'}</span></td><td>${esc(time(order.paidAt))}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">暂无订单</td></tr>';
    document.querySelector('#events').innerHTML = events.map(event => `<tr><td>${esc(time(event.created_at))}</td><td>${event.type === 'click' ? '点击' : '访问'}</td><td>${esc(event.target)}</td><td>${esc(event.visitor_id.slice(0,8))}…</td></tr>`).join('') || '<tr><td colspan="4" class="empty">暂无记录</td></tr>';
    document.querySelector('#conversations').innerHTML = conversations.map(item => `<button data-id="${esc(item.visitorId)}" class="${item.visitorId === activeVisitor ? 'active' : ''}">${esc(item.visitorId.slice(0,10))}… · ${item.messageCount}条</button>`).join('') || '<span class="empty">暂无会话</span>';
    document.querySelectorAll('#conversations button').forEach(button => button.onclick = () => { activeVisitor = button.dataset.id; refresh(); });
    await loadMessages();
  } catch (error) { if (error.message === 'Login required') loginScreen(); else console.error(error); }
}
async function dashboard() { dashboardShell(); await refresh(); clearInterval(timer); timer = setInterval(refresh, 4000); }
dashboard();
