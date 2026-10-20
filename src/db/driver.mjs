// SQLite 驱动适配层：对 node:sqlite 进行薄封装，未来若切换到 better-sqlite3 只需改写此文件
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// 在进程内优雅拦截屏蔽 node:sqlite 的 ExperimentalWarning，不依赖命令行特定参数
const originalEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
  if (typeof warning === 'string' && warning.includes('SQLite is an experimental feature')) {
    return;
  }
  if (warning && typeof warning === 'object' && warning.name === 'ExperimentalWarning' && String(warning.message).includes('SQLite')) {
    return;
  }
  return originalEmitWarning.call(process, warning, ...args);
};

export class DatabaseDriver {
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.rawDb = new DatabaseSync(dbPath);
    
    // 配置关键 PRAGMA：WAL 模式 + busy_timeout（防止 Web 与采集进程并发写入报 SQLITE_BUSY）
    this.exec('PRAGMA journal_mode = WAL;');
    this.exec('PRAGMA synchronous = NORMAL;');
    this.exec('PRAGMA busy_timeout = 8000;'); // 8秒等待锁
    this.exec('PRAGMA foreign_keys = ON;');
  }

  exec(sql) {
    return this.rawDb.exec(sql);
  }

  prepare(sql) {
    const stmt = this.rawDb.prepare(sql);
    return {
      run: (...params) => stmt.run(...params),
      get: (...params) => stmt.get(...params),
      all: (...params) => stmt.all(...params),
    };
  }

  close() {
    return this.rawDb.close();
  }
}

export function createDatabaseDriver(dbPath) {
  return new DatabaseDriver(dbPath);
}
