// 数据库 Schema 定义与版本迁移管理
import { resolve } from 'node:path';
import { createDatabaseDriver } from './driver.mjs';
import { ROOT } from '../config.mjs';

export const DEFAULT_DB_PATH = resolve(ROOT, 'data/stock_monitor.db');
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * 获取驱动封装的数据库连接
 */
export function getDbConnection(dbPath = DEFAULT_DB_PATH) {
  return createDatabaseDriver(dbPath);
}

/**
 * 迁移并初始化表结构
 */
export function migrateDatabase(db) {
  const versionStmt = db.prepare('PRAGMA user_version;');
  const currentVer = versionStmt.get()['user_version'] || 0;

  if (currentVer < 1) {
    db.exec(`
      -- 1. 监控标的配置表
      CREATE TABLE IF NOT EXISTS stocks (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        market TEXT NOT NULL, -- 'sh' | 'sz'
        enabled INTEGER NOT NULL DEFAULT 1, -- 1=启用, 0=停用
        notes TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      -- 2. 实时行情快照表
      CREATE TABLE IF NOT EXISTS quotes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL,
        trade_time TEXT NOT NULL,
        price REAL,
        prev_close REAL,
        open_price REAL,
        high REAL,
        low REAL,
        change_pct REAL,
        volume_hand INTEGER,
        amount_wan REAL,
        turnover_rate REAL,
        amplitude REAL,
        volume_ratio REAL,
        float_cap_yi REAL,
        total_cap_yi REAL,
        pb REAL,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (code) REFERENCES stocks (code) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_quotes_code_time ON quotes (code, trade_time);

      -- 3. 资金流向时序表（金额统一按'元'存储，展示层再换算）
      CREATE TABLE IF NOT EXISTS fund_flows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        main_net REAL, -- 主力净流入（元）
        super_large_net REAL, -- 超大单净流入（元）
        large_net REAL, -- 大单净流入（元）
        mid_net REAL, -- 中单净流入（元）
        small_net REAL, -- 小单净流入（元）
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE(code, trade_date),
        FOREIGN KEY (code) REFERENCES stocks (code) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_fund_flows_code_date ON fund_flows (code, trade_date);

      -- 4. 公告表（巨潮资讯唯一公告ID为主键）
      CREATE TABLE IF NOT EXISTS announcements (
        ann_id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        title TEXT NOT NULL,
        publish_time TEXT NOT NULL,
        ann_url TEXT NOT NULL,
        raw_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (code) REFERENCES stocks (code) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_ann_code_time ON announcements (code, publish_time);

      -- 5. 盘后数据表（龙虎榜、大宗交易、融资融券）
      CREATE TABLE IF NOT EXISTS post_market_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        data_type TEXT NOT NULL, -- 'lhb' | 'block_trade' | 'margin'
        summary TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE(code, trade_date, data_type, summary),
        FOREIGN KEY (code) REFERENCES stocks (code) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_post_market_query ON post_market_data (code, trade_date, data_type);

      -- 6. 事件表（替代原有的 state.json，支持黄升红重新推送）
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        category TEXT NOT NULL, -- '公告' | '资金'
        level TEXT NOT NULL, -- '红' | '黄' | '绿'
        time TEXT NOT NULL,
        summary TEXT NOT NULL,
        impact TEXT DEFAULT '中性',
        source TEXT NOT NULL,
        url TEXT DEFAULT '',
        first_pushed_at TEXT NOT NULL,
        last_pushed_at TEXT NOT NULL,
        FOREIGN KEY (code) REFERENCES stocks (code) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_events_code_time ON events (code, time);
      CREATE INDEX IF NOT EXISTS idx_events_level ON events (level);

      -- 7. 采集与补偿任务记录（pipeline_runs）
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_mode TEXT NOT NULL, -- 'realtime' | 'catchup' | 'compensate'
        target_code TEXT, -- NULL表示全部，非NULL表示单标的
        start_time TEXT NOT NULL,
        end_time TEXT,
        status TEXT NOT NULL, -- 'running' | 'success' | 'failed' | 'partial'
        issues_json TEXT, -- 数据源失败列表
        summary TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      -- 8. AI 结构化分析缓存表
      CREATE TABLE IF NOT EXISTS ai_analysis (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_type TEXT NOT NULL, -- 'event' | 'daily_summary'
        target_id TEXT NOT NULL, -- 对应的 event_id 或复合 key
        model TEXT NOT NULL,
        prompt_ver TEXT NOT NULL,
        sentiment TEXT NOT NULL, -- '利好' | '利空' | '中性'
        summary TEXT NOT NULL,
        confidence REAL,
        raw_output TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE(target_type, target_id, model, prompt_ver)
      );

      -- 9. 会话与对话消息表
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        stock_code TEXT, -- 绑定的个股（可为 NULL）
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (stock_code) REFERENCES stocks (code) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL, -- 'user' | 'assistant' | 'system'
        content TEXT NOT NULL,
        context_refs TEXT, -- JSON 格式，引用的行情/公告/事件 ID 列表
        status TEXT NOT NULL DEFAULT 'completed', -- 'completed' | 'partial' | 'failed'
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conversation_id, id);

      PRAGMA user_version = 1;
    `);
  }
}
