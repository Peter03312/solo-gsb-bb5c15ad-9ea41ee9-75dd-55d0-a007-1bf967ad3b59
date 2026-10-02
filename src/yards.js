'use strict';

/**
 * 演练副本（命名站场副本）。
 *
 * 语义（与需求一一对应）：
 *  - 管理员可【从原站场】创建命名演练副本；同名拒绝（yards.name UNIQUE 兜底）。
 *  - 创建在同一事务内复制：站场定义（区段/道岔/信号机/进路定义）、
 *    区段占用与道岔位置、开放进路的锁与事件进度（route_instances/route_locks/
 *    section_events）、未兑现等待申请（waiting_applications 中 waiting）、
 *    未完结延时取消（cancellation_applications 中 pending，沿用原到期时刻，
 *    不重新计时）及未完结临时封锁（blockade_applications 中 pending/active）。
 *  - 历史交接单不复制（handover_documents 留在原站场）；已结束/已兑现等历史
 *    业务记录也不带入副本。
 *  - 每个登录会话可选择当前站场（sessions.current_yard_id）；未选择时使用
 *    原站场。副本与原站场独立运行（各自独立 SQLite 文件），锁闭与等待顺位
 *    不得串用。
 *  - 未知副本拒绝（YARD_NOT_FOUND）；只有管理员能创建副本（越权 403）。
 */

const path = require('path');
const fs = require('fs');
const { getCatalog, openYardDb, yardDbs, ORIGINAL_YARD_ID, catalogPath, runInYard } = require('./db');
const { InterlockError } = require('./interlocking');

const MAX_NAME_LEN = 30;

/** 复制的业务表（显式列名，便于核对；交接单表不在其中）。
 *  实现上先用 VACUUM INTO 取整库一致快照，再在副本事务内删除以下范围之外的行。 */
const COPY_TABLES = [
  'sections',
  'switches',
  'signals',
  'routes',
  'route_steps',
  'route_switch_reqs',
  'route_instances',
  'route_locks',
  'section_events',
  'waiting_applications',
  'cancellation_applications',
  'blockade_applications'
];

/** 副本中各类表保留的行条件（删除其余历史行）；不列出的业务表整表清空。 */
const KEEP_WHERE = {
  route_instances: `status='open'`,
  waiting_applications: `status='waiting'`,
  cancellation_applications: `status='pending'`,
  blockade_applications: `status IN ('pending','active')`
};

/** 副本设置类元数据键（如延时取消保护时长）随副本复制，其余不复制 */
const COPY_META_KEYS = ['cancel_protection_seconds'];

/** 副本库不保留的目录/会话/历史表（整表清空） */
const COPY_DROP_ROWS = [
  'sessions',
  'yards',
  'handover_documents' // 历史交接单留在原站场，不带入副本
];

/* ------------------------------ 查询 / 描述 ------------------------------ */

function rowToYard(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    sourceId: row.source_id,
    status: row.status,
    isOriginal: false,
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

/** 原站场描述（固定 id=0）。 */
function originalYard() {
  return {
    id: ORIGINAL_YARD_ID,
    name: '原站场',
    sourceId: null,
    status: 'ready',
    isOriginal: true,
    createdBy: null,
    createdAt: null
  };
}

function getYard(yardId) {
  const id = Number(yardId);
  if (!Number.isInteger(id) || id < 0) return null;
  if (id === ORIGINAL_YARD_ID) return originalYard();
  const row = getCatalog().prepare(`SELECT * FROM yards WHERE id=?`).get(id);
  return rowToYard(row);
}

/** 解析会话选择的当前站场；非法（未知副本）返回 null。 */
function resolveSessionYard(session) {
  const id = Number(session && session.current_yard_id) || ORIGINAL_YARD_ID;
  return getYard(id);
}

/** 全部站场：原站场在前，副本按编号升序。 */
function listYards() {
  const rows = getCatalog().prepare(`SELECT * FROM yards ORDER BY id`).all();
  return [originalYard(), ...rows.map(rowToYard)];
}

/* -------------------------------- 创建副本 -------------------------------- */

function validateName(raw) {
  const name = String(raw == null ? '' : raw).trim();
  if (!name) {
    throw new InterlockError(400, 'YARD_NAME_REQUIRED', '演练副本名称不能为空');
  }
  if (name.length > MAX_NAME_LEN) {
    throw new InterlockError(400, 'YARD_NAME_TOO_LONG',
      `演练副本名称过长（最多 ${MAX_NAME_LEN} 字）`);
  }
  if (name === '原站场') {
    throw new InterlockError(400, 'YARD_NAME_RESERVED',
      '“原站场”为内置名称，不能作为演练副本名称');
  }
  return name;
}

function sqlQuoteLiteral(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/**
 * 从原站场创建命名演练副本。
 * 先用 VACUUM INTO 取原站场整库一致快照（复制在源库单语句内原子完成，
 * 不阻塞运行中的业务），再在副本库的单个事务内删除会话/副本登记/历史交接单
 * 及各类已结束历史业务行。任一步失败都会清理半成品文件与登记，不留半成品。
 *
 * @param {{name:string, createdBy?:string}}
 * @returns {{yard:Object, counts:Object}}
 */
function createCopy({ name: rawName, createdBy = null } = {}) {
  const name = validateName(rawName);
  const catalog = getCatalog();

  if (catalog.prepare(`SELECT 1 FROM yards WHERE name=?`).get(name)) {
    throw new InterlockError(409, 'YARD_NAME_EXISTS',
      `演练副本“${name}”已存在，请换一个名称`);
  }

  // 1) 目录库事务：登记副本（先占编号与文件名）；复制失败时删除登记
  let yardId;
  let filePath;
  const register = catalog.transaction(() => {
    let info;
    try {
      info = catalog.prepare(
        `INSERT INTO yards(name,source_id,status,file_path,created_by)
         VALUES(?, 0, 'ready', '', ?)`
      ).run(name, createdBy);
    } catch (e) {
      if (String(e.code) === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new InterlockError(409, 'YARD_NAME_EXISTS',
          `演练副本“${name}”已存在，请换一个名称`);
      }
      throw e;
    }
    yardId = Number(info.lastInsertRowid);
    filePath = path.join(path.dirname(catalogPath()), `yard-${yardId}.db`);
    catalog.prepare(`UPDATE yards SET file_path=? WHERE id=?`).run(filePath, yardId);
  });
  register();

  // 2) VACUUM INTO 快照 + 副本库单事务裁剪
  try {
    if (fs.existsSync(filePath)) {
      throw new InterlockError(409, 'YARD_FILE_EXISTS',
        `副本文件 ${path.basename(filePath)} 已存在，拒绝覆盖`);
    }
    const counts = snapshotAndPrune(filePath, yardId);

    // 3) 打开并缓存连接；在副本上下文内执行启动同款复核：
    //    封锁待生效复核 → 已到期延时取消按原时刻处理 → 等待兑现扫描
    openYardDb(yardId, filePath);
    runInYard(yardId, () => {
      try {
        require('./blockade').refreshBlockadeStates('yard_copied');
      } catch (e) {
        console.error(`[yard ${yardId}] 复制后封锁复核失败:`, e);
      }
      try {
        require('./cancellation').processDue('yard_copied');
      } catch (e) {
        console.error(`[yard ${yardId}] 复制后延时取消复核失败:`, e);
      }
      try {
        require('./waiting').sweepFulfillments('yard_copied');
      } catch (e) {
        console.error(`[yard ${yardId}] 复制后等待兑现扫描失败:`, e);
      }
    });

    return { yard: getYard(yardId), counts };
  } catch (e) {
    // 失败清理：关闭可能已缓存的连接、删除登记（目录事务）、删除半成品文件
    const cached = yardDbs.get(yardId);
    if (cached) {
      try { cached.close(); } catch (_) {}
      yardDbs.delete(yardId);
    }
    try {
      catalog.transaction(() => {
        catalog.prepare(`DELETE FROM yards WHERE id=?`).run(yardId);
      })();
    } catch (_) {}
    for (const f of [filePath, filePath + '-wal', filePath + '-shm']) {
      try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    }
    throw e;
  }
}

/**
 * 复制原站场为新文件并裁剪为"演练副本"初始内容：
 *  - VACUUM INTO 在源（原站场）库执行，原子生成整库一致快照（含全部表与数据、
 *    不含源连接的 WAL 临时状态）；复制的延时取消 requested_at/release_at 原样
 *    保留，因此到期时刻不变，重启/复核不重新计时、不重复兑现。
 *  - 随后在副本库单事务内删除：会话、副本登记、历史交接单，以及各类不属于
 *    "当前进行中"的历史业务行（已解除实例及其锁/事件、已结束等待/取消/封锁）。
 */
function snapshotAndPrune(filePath, yardId) {
  const source = getCatalog();
  // VACUUM INTO 目标必须不存在（上面已校验）；单语句原子快照
  source.exec(`VACUUM INTO ${sqlQuoteLiteral(filePath)}`);

  const conn = openYardDb(yardId, filePath);
  const counts = {};
  conn.transaction(() => {
    // 裁剪前快照中的复制行数（用于接口返回，统计在删除前的各类"保留行"）
    counts.sections = conn.prepare(`SELECT COUNT(*) n FROM sections`).get().n;
    counts.switches = conn.prepare(`SELECT COUNT(*) n FROM switches`).get().n;
    counts.signals = conn.prepare(`SELECT COUNT(*) n FROM signals`).get().n;
    counts.routes = conn.prepare(`SELECT COUNT(*) n FROM routes`).get().n;

    // 先按外键依赖顺序删除历史/非副本数据（foreign_keys=ON）
    // 1) 锁与事件：只保留仍开放实例的
    conn.prepare(
      `DELETE FROM route_locks
        WHERE instance_id IN (SELECT id FROM route_instances WHERE status<>'open')`
    ).run();
    conn.prepare(
      `DELETE FROM section_events
        WHERE instance_id IN (SELECT id FROM route_instances WHERE status<>'open')`
    ).run();
    // 2) 已解除进路实例（含其全部历史）
    conn.prepare(`DELETE FROM route_instances WHERE status<>'open'`).run();
    // 3) 已结束等待/延时取消/封锁
    conn.prepare(`DELETE FROM waiting_applications WHERE status<>'waiting'`).run();
    conn.prepare(`DELETE FROM cancellation_applications WHERE status<>'pending'`).run();
    conn.prepare(`DELETE FROM blockade_applications WHERE status NOT IN ('pending','active')`).run();
    // 4) 目录/会话/历史交接单：副本一律不带
    for (const t of COPY_DROP_ROWS) conn.prepare(`DELETE FROM ${t}`).run();
    // 5) 元数据：只保留白名单设置键
    const placeholders = COPY_META_KEYS.map(() => '?').join(',');
    conn.prepare(`DELETE FROM meta WHERE key NOT IN (${placeholders})`)
      .run(...COPY_META_KEYS);

    // 复制结果计数
    counts.routeInstances = conn.prepare(
      `SELECT COUNT(*) n FROM route_instances WHERE status='open'`).get().n;
    counts.routeLocks = conn.prepare(`SELECT COUNT(*) n FROM route_locks`).get().n;
    counts.sectionEvents = conn.prepare(`SELECT COUNT(*) n FROM section_events`).get().n;
    counts.waitingApplications = conn.prepare(
      `SELECT COUNT(*) n FROM waiting_applications WHERE status='waiting'`).get().n;
    counts.cancellationApplications = conn.prepare(
      `SELECT COUNT(*) n FROM cancellation_applications WHERE status='pending'`).get().n;
    counts.blockadeApplications = conn.prepare(
      `SELECT COUNT(*) n FROM blockade_applications WHERE status IN ('pending','active')`).get().n;
    counts.handovers = 0;
  })();

  // 将自增序列对齐到已复制数据，避免后续新建编号与复制行冲突
  // （VACUUM INTO 会保留 sqlite_sequence；这里不重置，旧编号继续沿用是安全的。）
  return counts;
}

/* ------------------------------ 会话选择站场 ------------------------------ */

/**
 * 设置会话当前站场。yardId=0 表示回到原站场；未知副本拒绝。
 * 会话行始终在目录库。
 */
function selectYardForSession(token, yardId) {
  const catalog = getCatalog();
  const id = Number(yardId);
  if (!Number.isInteger(id) || id < 0) {
    throw new InterlockError(400, 'BAD_YARD_ID', '站场编号必须为非负整数');
  }
  if (id !== ORIGINAL_YARD_ID) {
    const row = catalog.prepare(`SELECT id FROM yards WHERE id=?`).get(id);
    if (!row) throw new InterlockError(404, 'YARD_NOT_FOUND', `演练副本 ${id} 不存在`);
  }
  const info = catalog.prepare(`UPDATE sessions SET current_yard_id=? WHERE token=?`)
    .run(id, token);
  if (info.changes === 0) {
    throw new InterlockError(401, 'SESSION_NOT_FOUND', '会话不存在或已失效，请重新登录');
  }
  return getYard(id);
}

module.exports = {
  MAX_NAME_LEN,
  originalYard,
  getYard,
  resolveSessionYard,
  listYards,
  createCopy,
  selectYardForSession
};
