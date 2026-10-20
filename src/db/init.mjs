// 数据库初始化脚本：建表、迁移、导入 config.json 中的初始股票标的
import { loadConfig } from '../config.mjs';
import { getRepo } from './repo.mjs';

export function initDatabase() {
  console.log('[DB] 正在初始化 SQLite 数据库...');
  const repo = getRepo();
  const config = loadConfig();
  if (Array.isArray(config.stocks) && config.stocks.length > 0) {
    repo.seedStocksIfEmpty(config.stocks);
    console.log(`[DB] 成功校验/写入初始股票标的种子数据，共 ${config.stocks.length} 只。`);
  }
  const allStocks = repo.getAllStocks();
  console.log(`[DB] 当前数据库中股票数量: ${allStocks.length}`);
  for (const s of allStocks) {
    console.log(`  - [${s.enabled ? '启用' : '停用'}] ${s.code} ${s.name} (${s.market}) ${s.notes ? `[${s.notes}]` : ''}`);
  }
  console.log('[DB] 数据库初始化成功完成。');
  return repo;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/db/init.mjs')) {
  try {
    initDatabase();
  } catch (err) {
    console.error('[DB] 初始化失败:', err);
    process.exit(1);
  }
}
