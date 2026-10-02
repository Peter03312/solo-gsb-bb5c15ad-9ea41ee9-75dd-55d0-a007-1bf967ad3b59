'use strict';

const express = require('express');
const { requireAuth, tokenOf } = require('../auth');
const yards = require('../yards');

/**
 * 会话当前站场：管理员与值班员均使用同一组接口。
 *  - GET  /api/session       当前会话信息 + 全部可选站场
 *  - PUT  /api/session/yard  选择当前站场（{yardId:0} 回到原站场；未知副本拒绝）
 */
const router = express.Router();
router.use(requireAuth());

router.get('/session', (req, res) => {
  res.json({
    ok: true,
    me: { role: req.session.role, name: req.session.name },
    yard: yards.getYard(Number(req.session.current_yard_id) || 0) || yards.originalYard(),
    yards: yards.listYards()
  });
});

router.put('/session/yard', (req, res) => {
  const yardId = Number((req.body || {}).yardId);
  const yard = yards.selectYardForSession(tokenOf(req), yardId);
  res.json({ ok: true, yard, yards: yards.listYards() });
});

module.exports = router;
