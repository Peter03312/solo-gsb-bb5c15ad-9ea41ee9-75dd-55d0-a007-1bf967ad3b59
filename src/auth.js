'use strict';

const crypto = require('crypto');
const { getDb, getCatalog, runInYard, ORIGINAL_YARD_ID } = require('./db');

/** 管理员口令：默认 admin123，可由 ADMIN_PASSWORD 覆盖 */
function adminPassword() {
  return process.env.ADMIN_PASSWORD || 'admin123';
}

/**
 * 创建会话。会话表位于目录库（原站场库）；current_yard_id 默认 0（原站场）。
 */
function createSession(role, name) {
  const token = crypto.randomBytes(24).toString('hex');
  getCatalog()
    .prepare(`INSERT INTO sessions(token,role,name,current_yard_id) VALUES(?,?,?,0)`)
    .run(token, role, name);
  return token;
}

/**
 * 读取会话。始终查目录库（会话不随站场复制）。
 * 返回含 current_yard_id；未知副本（副本登记缺失）时回退原站场并顺手复位。
 */
function getSession(token) {
  if (!token) return null;
  const row = getCatalog()
    .prepare(`SELECT token, role, name, current_yard_id FROM sessions WHERE token=?`)
    .get(token) || null;
  if (row && Number(row.current_yard_id) > 0) {
    const yard = getCatalog()
      .prepare(`SELECT id FROM yards WHERE id=?`).get(Number(row.current_yard_id));
    if (!yard) {
      getCatalog().prepare(`UPDATE sessions SET current_yard_id=0 WHERE token=?`).run(token);
      row.current_yard_id = 0;
    }
  }
  return row;
}

function destroySession(token) {
  if (token) getCatalog().prepare(`DELETE FROM sessions WHERE token=?`).run(token);
}

/** 从 Authorization: Bearer 或 cookie sid 中取令牌 */
function tokenOf(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * 鉴权中间件：校验会话后，把后续处理包在该会话所选站场的上下文中——
 * 业务模块的 getDb() 即自动指向当前站场（未选择=原站场）。
 * 这样既有接口的请求/响应约定保持不变，而数据天然按站场隔离。
 */
function requireAuth(role) {
  return (req, res, next) => {
    const session = getSession(tokenOf(req));
    if (!session) return res.status(401).json({ ok: false, error: '未登录或会话已失效，请重新登录' });
    if (role && session.role !== role) {
      return res.status(403).json({ ok: false, error: `需要 ${role === 'admin' ? '管理员' : '值班员'} 身份` });
    }
    req.session = session;
    const yardId = Number(session.current_yard_id) || ORIGINAL_YARD_ID;
    runInYard(yardId, () => next());
  };
}

module.exports = { adminPassword, createSession, getSession, destroySession, tokenOf, requireAuth };

