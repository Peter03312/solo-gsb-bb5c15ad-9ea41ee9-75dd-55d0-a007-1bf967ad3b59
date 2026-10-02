'use strict';

const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');
const Database = require('better-sqlite3');

/**
 * 多站场（原站场 + 命名演练副本）数据库管理。
 *
 *  - 目录库（catalog）：即原站场库（DB_PATH，默认 data/interlock.db），保存
 *    会话表 sessions、副本登记表 yards，以及原站场的全部业务数据。现有启动与
 *    数据文件位置保持不变。
 *  - 副本库：每个演练副本一个独立 SQLite 文件（yards.file_path），拥有完整业务
 *    表结构，天然隔离锁闭/等待顺位/延时取消/封锁/交接单。
 *  - 当前请求所在站场通过 AsyncLocalStorage（yardCtx）传递：所有业务模块的
 *    getDb() 在请求上下文内自动返回该站场连接，未显式选择时返回原站场库。
 *
 * better-sqlite3 为同步驱动：每个 .transaction() 在单个连接上串行执行；
 * 多连接各自串行，配合各库内 route_locks 唯一约束实现站场内的争用仲裁。
 */

const ORIGINAL_YARD_ID = 0;

const yardCtx = new AsyncLocalStorage();

let catalogDb = null;
const yardDbs = new Map(); // yardId(number) -> Database

function defaultDbPath() {
  return process.env.DB_PATH || path.join(__dirname, '..', 'data', 'interlock.db');
}

function openDatabase(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const conn = new Database(dbPath);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  // busy_timeout：并发事务撞锁时等待而不是立刻报 SQLITE_BUSY
  conn.pragma('busy_timeout = 5000');
  return conn;
}

/** 建表并执行存量库的轻量迁移（CREATE TABLE IF NOT EXISTS 不会补加列）。 */
function initSchema(conn) {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  conn.exec(schema);
  // 旧版 sessions 表无 current_yard_id 列：补齐（新建库已含该列）
  const cols = conn.prepare(`PRAGMA table_info(sessions)`).all().map((c) => c.name);
  if (!cols.includes('current_yard_id')) {
    conn.exec(`ALTER TABLE sessions ADD COLUMN current_yard_id INTEGER NOT NULL DEFAULT 0`);
  }
}

/**
 * 打开（或返回）目录库（原站场库）。
 * 启动、鉴权（会话表）、副本登记等"跨站场"场景使用。
 */
function getCatalog() {
  if (catalogDb) return catalogDb;
  catalogDb = openDatabase(defaultDbPath());
  initSchema(catalogDb);
  return catalogDb;
}

/**
 * 打开（或返回缓存的）某副本站场连接。调用前 yards 行应已存在。
 * @param {number} yardId 副本编号（yards.id）
 * @param {string} [filePath] 已知文件路径（创建副本时传入，避免竞态查库）
 */
function openYardDb(yardId, filePath) {
  const cached = yardDbs.get(yardId);
  if (cached) return cached;
  const file = filePath || getCatalog()
    .prepare(`SELECT file_path FROM yards WHERE id=?`).get(yardId).file_path;
  const conn = openDatabase(file);
  initSchema(conn);
  yardDbs.set(yardId, conn);
  return conn;
}

/** 当前请求上下文选择的站场编号；无上下文时为 0（原站场）。 */
function currentYardId() {
  const v = yardCtx.getStore();
  return Number.isInteger(v) && v > 0 ? v : ORIGINAL_YARD_ID;
}

/**
 * 业务模块统一入口：返回当前上下文站场的数据库连接。
 *  - 未进入任何站场上下文（如启动初始化）→ 原站场库；
 *  - 上下文为 0 → 原站场库；
 *  - 上下文为副本编号 → 该副本的独立库（副本不存在/已删除时抛错拒绝）。
 */
function getDb() {
  const id = currentYardId();
  if (id === ORIGINAL_YARD_ID) return getCatalog();
  if (yardDbs.has(id)) return yardDbs.get(id);
  const row = getCatalog().prepare(`SELECT id, file_path FROM yards WHERE id=?`).get(id);
  if (!row) {
    const err = new Error(`演练副本 ${id} 不存在`);
    err.status = 404;
    err.code = 'YARD_NOT_FOUND';
    throw err;
  }
  return openYardDb(row.id, row.file_path);
}

/** 在指定站场上下文内执行函数（同步代码与其触发的异步回调均继承该上下文）。 */
function runInYard(yardId, fn) {
  return yardCtx.run(Number(yardId) || ORIGINAL_YARD_ID, fn);
}

/** 目录库路径（副本文件与其同目录）。 */
function catalogPath() {
  return getCatalog().name;
}

module.exports = {
  ORIGINAL_YARD_ID,
  getCatalog,
  openYardDb,
  yardDbs,
  currentYardId,
  getDb,
  runInYard,
  catalogPath
};
