'use strict';

const path = require('path');
const express = require('express');

const { getDb, getCatalog, runInYard, currentYardId, ORIGINAL_YARD_ID } = require('./db');
const { seedDemo } = require('./seed');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const apiRoutes = require('./routes/api');
const sessionRoutes = require('./routes/session');
const { InterlockError } = require('./interlocking');
const waiting = require('./waiting');
const cancellation = require('./cancellation');
const blockade = require('./blockade');
const yards = require('./yards');

const PORT = Number(process.env.PORT || 3000);

/**
 * 全部已登记站场编号：原站场（0）+ yards 表中的全部副本。
 * 定时器/启动扫描据此逐个站场复核，互不串用。
 */
function allYardIds() {
  const ids = getCatalog().prepare(`SELECT id FROM yards ORDER BY id`).all().map((r) => r.id);
  return [ORIGINAL_YARD_ID, ...ids];
}

/** 在指定站场上下文内安全执行一段复核逻辑，异常只记录日志。 */
function runYardTask(yardId, label, fn) {
  try {
    runInYard(yardId, fn);
  } catch (e) {
    console.error(`[startup] 站场 ${yardId} ${label} 失败:`, e);
  }
}

/**
 * 单个站场的启动/周期复核：
 *  ① 待生效封锁复核（区段空闲且无进路锁 → 已生效）；
 *  ② 等待申请兑现扫描（状态全部来自该站场 SQLite，重启可恢复）；
 *  ③ 延时取消到期处理（复制的申请沿用原 release_at，到期即按该站场数据
 *     重查；未到期继续等待——不重新计时，已处理过的不会重复兑现）。
 */
function reconcileYard(yardId, trigger) {
  runYardTask(yardId, '封锁复核', () => {
    const activated = blockade.refreshBlockadeStates(trigger);
    if (activated.length) {
      console.log(`[yard ${yardId}] 封锁申请转为已生效：#${activated.join('、#')}`);
    }
  });
  runYardTask(yardId, '等待兑现扫描', () => {
    const r = waiting.sweepFulfillments(trigger);
    if (r.fulfilled.length) {
      console.log(`[yard ${yardId}] 自动兑现等待申请 #${r.fulfilled.join('、#')}`);
    }
  });
  runYardTask(yardId, '延时取消到期处理', () => {
    const r = cancellation.processDue(trigger);
    if (r.released.length) {
      console.log(`[yard ${yardId}] 延时取消到期核验通过、进路解除：申请 #${r.released.join('、#')}`);
    }
    if (r.aborted.length) {
      console.log(`[yard ${yardId}] 延时取消核验未通过、申请终止：申请 #${r.aborted.join('、#')}`);
    }
  });
}

// 启动即建表；首次且原站场库为空时写入示例数据（SEED_DEMO=0 可关闭）
const db = getDb();
if (process.env.SEED_DEMO !== '0') {
  const seeded = seedDemo(db);
  if (seeded) console.log('[startup] 已初始化示例站场（R1/R2/R3）');
}

// 逐站场启动复核（原站场 + 各副本分别处理；复制的延时取消按原到期时刻核对）
for (const yardId of allYardIds()) {
  reconcileYard(yardId, 'server_start');
}

// 之后每 0.5 秒逐站场扫描一次（各站场独立，不重新计时、不跨站场兑现）
const timer = setInterval(() => {
  for (const yardId of allYardIds()) reconcileYard(yardId, 'timer');
}, 500);
// 定时器不阻止进程退出（测试/关闭时可自然结束）
if (timer.unref) timer.unref();

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', sessionRoutes);
app.use('/api', apiRoutes);

// 兜底：未匹配的 /api 路径返回 JSON
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: '接口不存在' }));

// 统一错误处理
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof InterlockError) {
    return res.status(err.status).json({ ok: false, error: err.message, code: err.code, ...err.extra });
  }
  // getDb() 对未知副本等场景抛出的带 status 错误
  if (err && err.status) {
    return res.status(err.status).json({ ok: false, error: err.message, code: err.code || 'YARD_ERROR' });
  }
  console.error('[error]', err);
  res.status(500).json({ ok: false, error: '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`[startup] 进路联锁推演台已启动: http://localhost:${PORT}/（当前上下文站场 #${currentYardId()}）`);
});
