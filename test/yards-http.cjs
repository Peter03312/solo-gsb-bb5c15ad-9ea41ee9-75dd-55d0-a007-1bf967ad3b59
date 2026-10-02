'use strict';

/**
 * 命名演练副本 HTTP 端到端测试：
 *   管理员从原站场创建命名副本（同名拒绝/值班员越权 403/返回副本编号与状态）→
 *   同事务复制：站场定义、区段/道岔状态、开放进路的锁与事件进度、未兑现等待、
 *   未完结延时取消（沿用原到期时刻）与临时封锁；历史交接单留在原站场、历史
 *   进路/已结束申请不复制 →
 *   会话选择当前站场（默认原站场；未知副本 404；既有接口请求/响应兼容）→
 *   副本与原站场独立运行：开放/走行/扳岔/区段调整/等待/取消/封锁/交接单/
 *   拓扑编辑/重置互不影响，锁闭与等待顺位不串用 →
 *   服务重启后按各站场分别复核：复制的延时取消不重新计时、到期按副本解除、
 *   原站场不被连带处理、不重复兑现。
 *
 * 运行：node test/yards-http.cjs
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || 3925;
const DB_PATH = process.env.SMOKE_DB_YARDS || path.join(__dirname, '..', 'data', 'yards-test.db');
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function ok(name, cond, extra) {
  if (!cond) throw new Error(name + (extra ? `（${JSON.stringify(extra)}）` : ''));
  console.log('  ✓', name);
  passed++;
}
function eq(name, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${name}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
  console.log('  ✓', name);
  passed++;
}

let server = null;
function startServer(keepDb = false) {
  return new Promise((resolve, reject) => {
    if (!keepDb) {
      // 删除原站场库与全部副本库文件
      const dir = path.dirname(DB_PATH);
      const base = path.basename(DB_PATH, '.db');
      for (const f of fs.readdirSync(dir)) {
        if (f === base + '.db' || f.startsWith(base + '.db-') ||
            (f.startsWith('yard-') && f.endsWith('.db')) ||
            f.match(/^yard-\d+\.db-(wal|shm)$/)) {
          try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
        }
      }
    }
    server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), DB_PATH, SEED_DEMO: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error('服务启动超时: ' + out)), 10000);
    server.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('已启动')) { clearTimeout(timer); resolve(); }
    });
    server.stderr.on('data', (d) => { out += d.toString(); });
    server.on('exit', (code) => { if (code !== 0) reject(new Error('服务异常退出: ' + out)); });
  });
}
function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.on('exit', () => { server = null; resolve(); });
    server.kill('SIGTERM');
    setTimeout(() => { try { server.kill('SIGKILL'); } catch (_) {} }, 3000);
  });
}

async function api(p, { token, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const resp = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await resp.json(); } catch (_) {}
  return { status: resp.status, data };
}
async function login(role, nameOrPwd) {
  const body = role === 'admin' ? { password: nameOrPwd || 'admin123' } : { name: nameOrPwd };
  const { status, data } = await api(`/api/auth/login/${role}`, { method: 'POST', body });
  if (status !== 200) throw new Error('登录失败: ' + data.error);
  return data.token;
}
const state = (token) => api('/api/state', { token }).then((r) => r.data.state);
const selectYard = (token, yardId) =>
  api('/api/session/yard', { token, method: 'PUT', body: { yardId } });

async function openRoute(token, routeId, positions) {
  const r = await api(`/api/routes/${routeId}/open`, { token, method: 'POST', body: { switchPositions: positions } });
  if (r.status !== 200) throw new Error('开放失败: ' + JSON.stringify(r.data));
  return r.data.instance.id;
}
async function waitFor(token, url, pred, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await api(url, { token });
    if (pred(r.data)) return r.data;
    if (Date.now() > deadline) throw new Error('等待超时: ' + url);
    await sleep(120);
  }
}

async function main() {
  await startServer();
  const admin = await login('admin');
  const jia = await login('dispatcher', '值班员甲');
  const yi = await login('dispatcher', '值班员乙');

  console.log('\n[1] 创建副本：校验、同名拒绝、越权拒绝');
  // 未登录 / 值班员越权
  let r = await api('/api/admin/yards', { method: 'POST', body: { name: '演练一' } });
  eq('未登录创建 401', r.status, 401);
  r = await api('/api/admin/yards', { token: jia, method: 'POST', body: { name: '演练一' } });
  eq('值班员创建 403', r.status, 403);
  // 空名/超长/保留名
  for (const bad of ['', '   ']) {
    r = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: bad } });
    eq(`空名 400 (${JSON.stringify(bad)})`, r.status, 400);
    eq('错误码 YARD_NAME_REQUIRED', r.data.code, 'YARD_NAME_REQUIRED');
  }
  r = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: '原站场' } });
  eq('保留名 400', r.status, 400);
  eq('错误码 YARD_NAME_RESERVED', r.data.code, 'YARD_NAME_RESERVED');

  console.log('\n[2] 原站场造好可复制的盘面：开放/走行进度/等待/延时取消/封锁/交接单/历史记录');
  // 保护时长 100 秒（便于验证复制后不重新计时）
  await api('/api/admin/settings/cancel-protection', { token: admin, method: 'PUT', body: { protectionSeconds: 100 } });
  // 扳一个道岔到 R 并置区段 2 占用（验证状态复制）
  r = await api('/api/switches/SW7/move', { token: yi, method: 'POST', body: { position: 'R' } });
  eq('扳 SW7 到 R', r.status, 200);
  r = await api('/api/sections/2/state', { token: jia, method: 'POST', body: { action: 'occupy' } });
  eq('置区段2占用', r.status, 200);

  // 开放 R2（SW7=N? R2 需要 SW7=N SW8=R）——先扳回 SW7=N、SW8=R
  await api('/api/switches/SW7/move', { token: yi, method: 'POST', body: { position: 'N' } });
  r = await api('/api/switches/SW8/move', { token: jia, method: 'POST', body: { position: 'R' } });
  eq('扳 SW8 到 R', r.status, 200);
  const iid = await openRoute(jia, 'R2', { SW7: 'N', SW8: 'R' });
  eq('原站场开放 R2 实例 #1', iid, 1);
  // 走行前两个事件：占用1、占用3（验证事件进度/逐段解锁复制；注意区段2占用不影响 R2）
  r = await api(`/api/instances/${iid}/events`, { token: jia, method: 'POST', body: { seq: 1, sectionId: '1', action: 'occupy' } });
  eq('事件1 受理', r.status, 200);
  r = await api(`/api/instances/${iid}/events`, { token: jia, method: 'POST', body: { seq: 2, sectionId: '3', action: 'occupy' } });
  eq('事件2 受理', r.status, 200);
  // 延时取消（实例已有占用 → 应被拒绝，仅对无占用实例有效；改用另一实例验证）
  // 这里直接验证取消只能给无占用实例：R2 已有占用，申请 409
  r = await api(`/api/instances/${iid}/cancel-delayed`, { token: jia, method: 'POST' });
  eq('有占用的实例申请延时取消 409', r.status, 409);
  eq('错误码 CANCEL_OCCUPANCY_EXISTS', r.data.code, 'CANCEL_OCCUPANCY_EXISTS');

  // 为复制"未完结延时取消"：先走完 R2 释放，再开一条无走行的 R1 并申请延时取消
  await api(`/api/instances/${iid}/events`, { token: jia, method: 'POST', body: { seq: 3, sectionId: '1', action: 'clear' } });
  await api(`/api/instances/${iid}/events`, { token: jia, method: 'POST', body: { seq: 4, sectionId: '4', action: 'occupy' } });
  await api(`/api/instances/${iid}/events`, { token: jia, method: 'POST', body: { seq: 5, sectionId: '3', action: 'clear' } });
  await api(`/api/instances/${iid}/events`, { token: jia, method: 'POST', body: { seq: 6, sectionId: '4', action: 'clear' } });
  // R2 走完，SW7/SW8 锁释放；扳回 N,N 开 R1
  await api('/api/switches/SW8/move', { token: jia, method: 'POST', body: { position: 'N' } });
  const iid2 = await openRoute(jia, 'R1', { SW7: 'N', SW8: 'N' });
  r = await api(`/api/instances/${iid2}/cancel-delayed`, { token: jia, method: 'POST' });
  eq('R1 申请延时取消 201', r.status, 201);
  const origReleaseAt = r.data.cancellation.releaseAt;
  const cancelId = r.data.cancellation.id;
  ok('取消为 pending', r.data.cancellation.status === 'pending');

  // 未兑现等待：封锁区段5 后提交 R3 等待（SW7=R,SW8=N）；静态校验不查实际位置与锁
  r = await api('/api/admin/blockades', { token: admin, method: 'POST', body: { sectionId: '5', reason: '施工封锁' } });
  eq('封锁区段5（R1 锁着→待生效）', r.status, 201);
  const blockadeId = r.data.blockade.id;
  eq('封锁待生效', r.data.blockade.status, 'pending');
  r = await api('/api/routes/R3/waiting', { token: yi, method: 'POST', body: { switchPositions: { SW7: 'R', SW8: 'N' } } });
  eq('R3 等待提交 201', r.status, 201);
  const waitingId = r.data.waiting.id;
  eq('R3 等待中', r.data.waiting.status, 'waiting');

  // 交接单（留在原站场）
  r = await api('/api/handovers', { token: jia, method: 'POST' });
  eq('原站场生成交接单 201', r.status, 201);
  const handoverId = r.data.handover.id;

  // 历史进路（R2 已 released）应存在于原站场复盘但不复制
  let st = await state(jia);
  ok('原站场有已解除历史实例', st.recentReleased.some((x) => x.id === iid), st.recentReleased.map((x) => x.id));

  console.log('\n[3] 创建副本：返回编号/状态，复制内容正确');
  r = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: ' 演练一 ' } });
  eq('创建 201', r.status, 201);
  eq('created 语义：状态 ready', r.data.status, 'ready');
  const yardId = r.data.yard.id;
  ok('副本编号为正整数', Number.isInteger(yardId) && yardId > 0, r.data.yard);
  eq('名称去空白', r.data.yard.name, '演练一');
  eq('来源为原站场(0)', r.data.yard.sourceId, 0);
  eq('复制计数：开放实例 1', r.data.copied.routeInstances, 1);
  eq('复制计数：锁 5', r.data.copied.routeLocks, 5); // 3 区段 + 2 道岔
  eq('复制计数：未兑现等待 1', r.data.copied.waitingApplications, 1);
  eq('复制计数：未完结取消 1', r.data.copied.cancellationApplications, 1);
  eq('复制计数：未完结封锁 1', r.data.copied.blockadeApplications, 1);

  // 同名拒绝（含去空白同名）
  r = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: '演练一' } });
  eq('同名 409', r.status, 409);
  eq('错误码 YARD_NAME_EXISTS', r.data.code, 'YARD_NAME_EXISTS');

  // 列表
  r = await api('/api/admin/yards', { token: admin });
  eq('列表含原站场+1副本', r.data.yards.length, 2);
  eq('列表首项为原站场 id=0', r.data.yards[0].id, 0);
  ok('原站场 isOriginal', r.data.yards[0].isOriginal);

  console.log('\n[4] 会话选择站场：默认原站场；未知副本拒绝；切换后接口作用于副本');
  r = await api('/api/session', { token: jia });
  eq('当前默认原站场', r.data.yard.id, 0);
  eq('会话接口 200', r.status, 200);
  r = await selectYard(jia, 999);
  eq('未知副本 404', r.status, 404);
  eq('错误码 YARD_NOT_FOUND', r.data.code, 'YARD_NOT_FOUND');
  r = await selectYard(jia, yardId);
  eq('切换副本 200', r.status, 200);
  r = await api('/api/session', { token: jia });
  eq('当前为副本', r.data.yard.id, yardId);
  // 其他会话不受影响
  r = await api('/api/session', { token: yi });
  eq('乙仍在原站场', r.data.yard.id, 0);
  // 回到原站场
  r = await selectYard(yi, 0);
  eq('切回原站场 200', r.status, 200);
  eq('yardId=0 为原站场', r.data.yard.id, 0);
  // 让乙也留在原站场；甲在副本
  await selectYard(jia, yardId);

  console.log('\n[5] 副本数据快照正确（定义/状态/锁与事件进度/等待/取消/封锁；无交接单无历史）');
  st = await state(jia); // 甲在副本
  eq('副本 yard 信息随 state 下发', (await api('/api/state', { token: jia })).data.yard.id, yardId);
  eq('区段定义数 5', st.sections.length, 5);
  eq('道岔定义数 2', st.switches.length, 2);
  eq('信号机数 4', st.signals.length, 4);
  eq('进路数 3', st.routes.length, 3);
  // 状态复制：SW8=N（开放 R1 要求），SW7=N（开 R1 前扳回定位），区段2占用
  eq('SW7 位置复制为 N', st.switches.find((x) => x.id === 'SW7').position, 'N');
  eq('SW8 位置复制为 N', st.switches.find((x) => x.id === 'SW8').position, 'N');
  eq('区段2占用复制', st.sections.find((x) => x.id === '2').occ_state, 'occupied');
  // 开放实例：R1（iid2），锁 3 区段+2 道岔，无事件（R1 没走行）
  eq('副本开放实例 1 条', st.openInstances.length, 1);
  const copyInst = st.openInstances[0];
  eq('开放实例为 R1', copyInst.routeId, 'R1');
  eq('实例编号沿用', copyInst.id, iid2);
  eq('信号红（取消令其回红）', copyInst.signalState, 'red');
  eq('锁 3 区段', copyInst.lockedSections.length, 3);
  eq('锁 2 道岔', copyInst.lockedSwitches.length, 2);
  eq('R1 无走行事件', copyInst.events.length, 0);
  // 已解除历史实例（R2）不复制
  eq('无历史已解除实例', st.recentReleased.length, 0);
  // 等待
  const cw = st.waitingApplications.find((x) => x.id === waitingId);
  ok('未兑现等待已复制', cw && cw.status === 'waiting' && cw.routeId === 'R3', st.waitingApplications);
  // 延时取消：pending 且到期时刻与原站场一致（不重新计时）
  const cc = st.cancellationRequests.find((x) => x.id === cancelId);
  ok('未完结取消已复制', cc && cc.status === 'pending', st.cancellationRequests);
  eq('取消到期时刻沿用原时刻', cc.releaseAt, origReleaseAt);
  eq('副本保护时长复制为 100', st.cancelProtectionSeconds, 100);
  ok('副本取消仍在保护期内（剩余>80s）', cc.remainingMs > 80000, cc.remainingMs);
  // 封锁
  const cb = st.blockades.find((x) => x.id === blockadeId);
  ok('未完结封锁已复制', cb && cb.status === 'pending' && cb.sectionId === '5', st.blockades);
  // 交接单不复制
  eq('副本无交接单', st.handovers.length, 0);

  console.log('\n[6] 独立运行：锁闭不串用——副本与原站场可同时开放冲突进路');
  // 甲在副本：R1 已开放（复制来的）。乙在原站场：R1 也开放着；两边都持锁但互不冲突
  // 再让甲在副本尝试开放 R3（需 SW7=R、区段2占用被占→阻断），验证读到的是副本状态
  r = await api('/api/routes/R3/check', { token: jia, method: 'POST', body: { switchPositions: { SW7: 'R', SW8: 'N' } } });
  ok('副本预检读到副本区段2占用', r.data.check.reasons.some((x) => x.includes('区段 2') && x.includes('占用')), r.data.check.reasons);

  console.log('\n[7] 独立运行：副本扳岔/区段调整/走行/解锁 不影响原站场');
  // 副本 R1 走完全程（先首段占用，终止取消），全部操作仅副本
  const seq = [
    [1, '1', 'occupy'], [2, '3', 'occupy'], [3, '1', 'clear'],
    [4, '5', 'occupy'], [5, '3', 'clear'], [6, '5', 'clear']
  ];
  for (const [n, sid, act] of seq) {
    const rr = await api(`/api/instances/${iid2}/events`, { token: jia, method: 'POST', body: { seq: n, sectionId: sid, action: act } });
    if (rr.status !== 200) throw new Error('副本走行失败: ' + JSON.stringify(rr.data));
    if (n === 1) ok('首段占用终止副本取消', rr.data.result.cancellationAborted === cancelId);
  }
  await sleep(0.6);
  st = await state(jia);
  eq('副本 R1 走完已解除', st.openInstances.some((x) => x.id === iid2), false);

  // 原站场（乙）：R1 仍开放、取消仍 pending、信号红、锁仍在
  st = await state(yi);
  const oInst = st.openInstances.find((x) => x.id === iid2);
  ok('原站场 R1 仍开放', !!oInst, st.openInstances.map((x) => x.id));
  eq('原站场信号仍红', oInst && oInst.signalState, 'red');
  eq('原站场锁仍 5 把', oInst && oInst.lockedSections.length + oInst.lockedSwitches.length, 5);
  const oc = st.cancellationRequests.find((x) => x.id === cancelId);
  eq('原站场取消仍 pending（未被副本走行终止）', oc.status, 'pending');
  // 原站场区段2仍占用，SW7=R；副本走完不影响
  eq('原站场区段2仍占用', st.sections.find((x) => x.id === '2').occ_state, 'occupied');
  // 原站场交接单仍在
  ok('原站场交接单仍在', st.handovers.some((x) => x.id === handoverId));
  // 原站场历史 R2 仍在复盘列表
  ok('原站场历史实例仍在', st.recentReleased.some((x) => x.id === iid));

  console.log('\n[8] 独立运行：等待顺位不串用——副本 R3 在副本资源释放后于副本兑现');
  // 副本 R1 走完后，区段5仍有复制来的封锁（R1 释放后复核可能转已生效，仍阻断 R3）。
  // 管理员必须先把【自己的会话】切到副本，结束的才是副本封锁（同号封锁两站场各有一条）。
  // 先把 SW7 扳到 R（副本）、区段2清空（副本），使 R3 除封锁/锁外满足开放条件
  await api('/api/sections/2/state', { token: jia, method: 'POST', body: { action: 'clear' } });
  await api('/api/switches/SW7/move', { token: jia, method: 'POST', body: { position: 'R' } });
  await selectYard(admin, yardId);
  r = await api(`/api/admin/blockades/${blockadeId}/end`, { token: admin, method: 'POST' });
  eq('管理员在副本结束副本封锁 200', r.status, 200);
  await selectYard(admin, 0);
  await sleep(0.6);
  let cwRow = await waitFor(jia, '/api/waiting?scope=all',
    (d) => d.waiting.some((x) => x.id === waitingId && x.status === 'fulfilled'));
  const fulfilled = cwRow.waiting.find((x) => x.id === waitingId);
  ok('副本 R3 等待在副本兑现为实例', Number.isInteger(fulfilled.instanceId), fulfilled);
  // 原站场 R3 等待仍 waiting（原站场 R1 仍开放锁着资源，兑现不跨站场）
  await waitFor(yi, '/api/waiting?scope=all',
    (d) => d.waiting.some((x) => x.id === waitingId && x.status === 'waiting'));
  st = await state(yi);
  ok('原站场 R3 等待仍 waiting（顺位/兑现不串用）',
    st.waitingApplications.some((x) => x.id === waitingId && x.status === 'waiting'));
  // 原站场封锁仍在（副本结束的是副本的同号记录）
  ok('原站场封锁仍未结束',
    st.blockades.some((x) => x.id === blockadeId && x.status !== 'ended'));

  console.log('\n[9] 独立运行：拓扑编辑与重置只作用于当前站场');
  // 先走完副本已兑现的 R3，释放其锁（有开放进路时拓扑不可编辑）
  const r3inst = fulfilled.instanceId;
  for (const [n, sid, act] of [
    [1, '2', 'occupy'], [2, '3', 'occupy'], [3, '2', 'clear'],
    [4, '5', 'occupy'], [5, '3', 'clear'], [6, '5', 'clear']
  ]) {
    const rr = await api(`/api/instances/${r3inst}/events`,
      { token: jia, method: 'POST', body: { seq: n, sectionId: sid, action: act } });
    if (rr.status !== 200) throw new Error('副本 R3 走行失败: ' + JSON.stringify(rr.data));
  }
  // 副本新增区段 9
  await selectYard(admin, yardId);
  r = await api('/api/admin/sections', { token: admin, method: 'POST',
    body: { id: '9', label: '9G', x1: 1, y1: 1, x2: 2, y2: 2 } });
  eq('副本新增区段9 200', r.status, 200);
  await selectYard(admin, 0);
  st = await state(yi);
  eq('原站场无副本新增的区段9', st.sections.some((x) => x.id === '9'), false);
  // 原站场重置：不影响副本（副本已走完 R3，但区段9仍在；交接单仍为空）
  r = await api('/api/admin/reset/state', { token: admin, method: 'POST' });
  eq('原站场重置 200', r.status, 200);
  eq('原站场重置后无开放实例', r.data.state.openInstances.length, 0);
  st = await state(jia);
  ok('副本仍保留区段9', st.sections.some((x) => x.id === '9'));
  eq('副本交接单始终为空', st.handovers.length, 0);
  // 副本交接单：在副本生成一张，验证留在副本
  r = await api('/api/handovers', { token: jia, method: 'POST' });
  eq('副本生成交接单 201', r.status, 201);
  const copyHandover = r.data.handover.id;
  r = await api('/api/handovers', { token: yi });
  ok('原站场看不到副本交接单', !r.data.handovers.some((x) => x.id === copyHandover));
  ok('原站场仍可见历史交接单（重置使其过期但保留）', r.data.handovers.some((x) => x.id === handoverId));

  console.log('\n[10] 服务重启：按各站场分别复核；复制的取消不重新计时、到期按副本解除、不重复');
  // 此时原站场刚重置（无取消）；在原站场重建一条未完结取消并从当前盘面再复制一副本
  await selectYard(jia, 0);
  await selectYard(admin, 0);
  await api('/api/admin/settings/cancel-protection', { token: admin, method: 'PUT', body: { protectionSeconds: 100 } });
  // 培训重开使区段空闲、道岔回 N
  await api('/api/admin/reset/training', { token: admin, method: 'POST' });
  const oIid = await openRoute(jia, 'R1', { SW7: 'N', SW8: 'N' });
  r = await api(`/api/instances/${oIid}/cancel-delayed`, { token: jia, method: 'POST' });
  const origRel = r.data.cancellation.releaseAt;
  eq('原站场取消 pending', r.data.cancellation.status, 'pending');

  // 再建一个带 pending 取消的副本（从原站场当前盘面复制）
  r = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: '重启演练' } });
  eq('创建第二个副本 201', r.status, 201);
  const yard2 = r.data.yard.id;
  eq('第二副本复制到 1 笔未完结取消', r.data.copied.cancellationApplications, 1);
  // 甲切到副本2，取取消信息
  await selectYard(jia, yard2);
  let before = await state(jia);
  let c2 = before.cancellationRequests[0];
  eq('副本2 取消 pending（复制后未立即处理）', c2.status, 'pending');
  eq('副本2 到期时刻=原站场到期时刻', c2.releaseAt, origRel);
  ok('副本2 剩余时间约 100s（未重新计时）', c2.remainingMs > 80000, c2.remainingMs);

  // 重启
  await stopServer();
  await startServer(true);
  // 会话持久化，令牌仍有效
  await selectYard(jia, yard2);
  let after = await state(jia);
  let c2b = after.cancellationRequests[0];
  eq('重启后副本2 取消仍 pending（未到期不处理）', c2b.status, 'pending');
  eq('重启后到期时刻不变（不重新计时）', c2b.releaseAt, origRel);
  ok('重启后剩余时间仍约 100s', c2b.remainingMs > 75000, c2b.remainingMs);
  // 原站场也仍 pending
  await selectYard(jia, 0);
  after = await state(jia);
  eq('原站场取消重启后仍 pending', after.cancellationRequests[0].status, 'pending');

  // 停机状态下把【副本2】的到期时刻改到过去（安全：服务已停），模拟到期
  await stopServer();
  {
    const Database = require('better-sqlite3');
    const file = path.join(path.dirname(DB_PATH), `yard-${yard2}.db`);
    const d = new Database(file);
    d.prepare(`UPDATE cancellation_applications SET release_at=release_at-200000 WHERE status='pending'`).run();
    d.close();
  }
  await startServer(true);
  await sleep(0.8);
  // 副本2：启动即按副本复核，解除
  await selectYard(jia, yard2);
  after = await state(jia);
  c2b = after.cancellationRequests[0];
  eq('副本2 到期后启动复核 → released', c2b.status, 'released');
  eq('副本2 进路已解除', after.openInstances.length, 0);
  // 原站场：仍 pending（不被连带处理）
  await selectYard(jia, 0);
  after = await state(jia);
  const oc2 = after.cancellationRequests[0];
  eq('原站场取消仍 pending（不跨站场兑现）', oc2.status, 'pending');
  eq('原站场进路仍开放', after.openInstances.length, 1);
  // 再重启：已 released 不重复处理
  await stopServer();
  await startServer(true);
  await sleep(0.6);
  await selectYard(jia, yard2);
  after = await state(jia);
  eq('再次重启副本2 取消保持 released（不重复兑现）', after.cancellationRequests[0].status, 'released');
  await selectYard(jia, 0);
  after = await state(jia);
  eq('再次重启原站场仍 pending', after.cancellationRequests[0].status, 'pending');

  console.log('\n[11] 退出登录只撤销各站场本人等待（不影响他人/不串用）');
  // 在原站场用新值班员提交一条等待后退出，验证只撤销本人
  await selectYard(jia, 0);
  const bing = await login('dispatcher', '值班员丙');
  await selectYard(bing, 0);
  // 原站场当前 R1 开放锁区段1/3/5；R3 等待会被锁阻断
  r = await api('/api/routes/R3/waiting', { token: bing, method: 'POST', body: { switchPositions: { SW7: 'R', SW8: 'N' } } });
  const bingW = r.data.waiting.id;
  // 甲也在原站场提交等待（与丙共享资源），退出丙不应撤销甲
  r = await api('/api/routes/R3/waiting', { token: jia, method: 'POST', body: { switchPositions: { SW7: 'R', SW8: 'N' } } });
  const jiaW = r.data.waiting.id;
  await api('/api/auth/logout', { token: bing, method: 'POST' });
  const wl = (await api('/api/waiting?scope=all', { token: jia })).data.waiting;
  eq('丙退出：其等待已撤销', wl.find((x) => x.id === bingW).status, 'cancelled');
  eq('丙退出：甲的等待不受影响', wl.find((x) => x.id === jiaW).status, 'waiting');

  await stopServer();
  console.log(`\n命名演练副本全部 ${passed} 项断言通过 ✅`);
}

main().catch(async (e) => {
  console.error('\n❌ 测试失败:', e);
  await stopServer();
  process.exit(1);
});
