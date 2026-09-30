import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

export const PLANS = Object.freeze({
  month: { name: '一个月', amountFen: 999 },
  year: { name: '一年', amountFen: 1399 },
  forever: { name: '永久', amountFen: 1999 },
});

export function createStore(path = 'data/lpay.db') {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, visitor_id TEXT NOT NULL, type TEXT NOT NULL, target TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (order_no TEXT PRIMARY KEY, visitor_id TEXT NOT NULL, plan_id TEXT NOT NULL, amount_fen INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, paid_at TEXT, transaction_id TEXT UNIQUE, openid TEXT);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, visitor_id TEXT NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  const now = () => new Date().toISOString();
  const orderShape = row => row && ({ orderNo: row.order_no, visitorId: row.visitor_id, planId: row.plan_id, planName: PLANS[row.plan_id]?.name, amountFen: row.amount_fen, status: row.status, createdAt: row.created_at, paidAt: row.paid_at, transactionId: row.transaction_id, openid: row.openid });
  return {
    recordEvent(visitorId, type, target) {
      if (!['page_view', 'click'].includes(type) || !visitorId || !target) throw new Error('Invalid event');
      db.prepare('INSERT INTO events(visitor_id,type,target,created_at) VALUES(?,?,?,?)').run(visitorId, type, target.slice(0, 100), now());
    },
    createOrder(planId, visitorId) {
      const plan = PLANS[planId];
      if (!plan || !visitorId) throw new Error('Invalid plan');
      const orderNo = `${Date.now()}${randomBytes(6).readUIntBE(0, 6).toString().padStart(15, '0')}`;
      db.prepare('INSERT INTO orders(order_no,visitor_id,plan_id,amount_fen,status,created_at) VALUES(?,?,?,?,?,?)').run(orderNo, visitorId, planId, plan.amountFen, 'PENDING', now());
      return this.order(orderNo);
    },
    order(orderNo) { return orderShape(db.prepare('SELECT * FROM orders WHERE order_no=?').get(orderNo)); },
    setOpenid(orderNo, openid) { db.prepare('UPDATE orders SET openid=? WHERE order_no=?').run(openid, orderNo); },
    markPaid(orderNo, amountFen, transactionId, paidAt = now()) {
      const order = this.order(orderNo);
      if (!order || order.amountFen !== amountFen || !transactionId) throw new Error('Payment mismatch');
      if (order.status === 'PAID') {
        if (order.transactionId !== transactionId) throw new Error('Conflicting transaction');
        return order;
      }
      db.prepare("UPDATE orders SET status='PAID',paid_at=?,transaction_id=? WHERE order_no=? AND status='PENDING'").run(paidAt, transactionId, orderNo);
      return this.order(orderNo);
    },
    stats() {
      const scalar = sql => db.prepare(sql).get().n;
      const p = db.prepare("SELECT COUNT(*) count,COALESCE(SUM(amount_fen),0) totalFen FROM orders WHERE status='PAID'").get();
      return { pageViews: scalar("SELECT COUNT(*) n FROM events WHERE type='page_view'"), visitors: scalar("SELECT COUNT(DISTINCT visitor_id) n FROM events WHERE type='page_view'"), clicks: scalar("SELECT COUNT(*) n FROM events WHERE type='click'"), orders: scalar('SELECT COUNT(*) n FROM orders'), payments: { count: p.count, totalFen: p.totalFen } };
    },
    recentEvents(limit = 50) { return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit); },
    orders(limit = 100) { return db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?').all(limit).map(orderShape); },
    addMessage(visitorId, sender, body) {
      if (!visitorId || !['visitor', 'staff'].includes(sender) || !body?.trim() || body.length > 2000) throw new Error('Invalid message');
      const result = db.prepare('INSERT INTO messages(visitor_id,sender,body,created_at) VALUES(?,?,?,?)').run(visitorId, sender, body.trim(), now());
      return db.prepare('SELECT * FROM messages WHERE id=?').get(result.lastInsertRowid);
    },
    messages(visitorId, afterId = 0) { return db.prepare('SELECT * FROM messages WHERE visitor_id=? AND id>? ORDER BY id ASC LIMIT 200').all(visitorId, afterId); },
    conversations() { return db.prepare('SELECT visitor_id AS visitorId, MAX(created_at) AS lastAt, COUNT(*) AS messageCount FROM messages GROUP BY visitor_id ORDER BY lastAt DESC LIMIT 100').all(); },
    close() { db.close(); },
  };
}
