'use strict';

const express = require('express');
const { adminPassword, createSession, getSession, destroySession, tokenOf } = require('../auth');
const { runInYard } = require('../db');
const waiting = require('../waiting');
const yards = require('../yards');

const router = express.Router();

// 值班员登录：输入姓名即可（新会话默认使用原站场，current_yard_id=0）
router.post('/login/dispatcher', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name.length < 1 || name.length > 30) {
    return res.status(400).json({ ok: false, error: '请输入值班员姓名（1~30 字）' });
  }
  const token = createSession('dispatcher', name);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true, token, role: 'dispatcher', name });
});

// 管理员登录：固定口令
router.post('/login/admin', (req, res) => {
  const password = String(req.body.password || '');
  if (password !== adminPassword()) {
    return res.status(401).json({ ok: false, error: '管理员口令不正确' });
  }
  const token = createSession('admin', '管理员');
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true, token, role: 'admin', name: '管理员' });
});

router.post('/logout', (req, res) => {
  const token = tokenOf(req);
  const session = getSession(token);
  // 值班员退出：在每个站场（原站场 + 全部副本）分别撤销其未兑现等待申请。
  // 各站场独立运行，撤销与后续兑现扫描必须落到对应库。
  if (session && session.role === 'dispatcher') {
    for (const y of yards.listYards()) {
      try {
        runInYard(y.id, () =>
          waiting.cancelByApplicant(session.name, '申请人退出登录，等待申请撤销'));
      } catch (e) { console.error(`[waiting] 退出撤销失败（站场 ${y.id}）:`, e); }
    }
  }
  destroySession(token);
  res.clearCookie('sid');
  res.json({ ok: true });
});

module.exports = router;
