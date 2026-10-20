// 数据访问仓储层：封装所有 SQL 操作，使用预编译语句提高性能
import { getDbConnection, migrateDatabase, DEFAULT_DB_PATH } from './schema.mjs';

let sharedDb = null;

export function getRepo(dbPath = DEFAULT_DB_PATH) {
  if (!sharedDb) {
    sharedDb = getDbConnection(dbPath);
    migrateDatabase(sharedDb);
  }
  return new StockRepository(sharedDb);
}

export class StockRepository {
  constructor(db) {
    this.db = db;
  }

  // ---------------- 标的管理 ----------------
  seedStocksIfEmpty(seedList = []) {
    const countRow = this.db.prepare('SELECT count(*) as count FROM stocks;').get();
    if (countRow.count === 0 && Array.isArray(seedList) && seedList.length > 0) {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO stocks (code, name, market, enabled, notes)
        VALUES (?, ?, ?, 1, '初始种子标的');
      `);
      this.db.exec('BEGIN TRANSACTION;');
      try {
        for (const s of seedList) {
          if (s.code && s.name && s.market) {
            stmt.run(String(s.code), String(s.name), String(s.market));
          }
        }
        this.db.exec('COMMIT;');
      } catch (e) {
        this.db.exec('ROLLBACK;');
        throw e;
      }
    }
  }

  getAllStocks() {
    return this.db.prepare('SELECT * FROM stocks ORDER BY enabled DESC, code ASC;').all();
  }

  getEnabledStocks() {
    return this.db.prepare('SELECT * FROM stocks WHERE enabled = 1 ORDER BY code ASC;').all();
  }

  getStock(code) {
    return this.db.prepare('SELECT * FROM stocks WHERE code = ?;').get(String(code));
  }

  upsertStock({ code, name, market, enabled = 1, notes = '' }) {
    const stmt = this.db.prepare(`
      INSERT INTO stocks (code, name, market, enabled, notes, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))
      ON CONFLICT(code) DO UPDATE SET
        name = excluded.name,
        market = excluded.market,
        enabled = excluded.enabled,
        notes = excluded.notes,
        updated_at = datetime('now', 'localtime');
    `);
    stmt.run(String(code), String(name), String(market), enabled ? 1 : 0, String(notes || ''));
    return this.getStock(code);
  }

  patchStock(code, fields = {}) {
    const cur = this.getStock(code);
    if (!cur) return null;
    const name = fields.name !== undefined ? fields.name : cur.name;
    const market = fields.market !== undefined ? fields.market : cur.market;
    const enabled = fields.enabled !== undefined ? (fields.enabled ? 1 : 0) : cur.enabled;
    const notes = fields.notes !== undefined ? fields.notes : cur.notes;

    this.db.prepare(`
      UPDATE stocks
      SET name = ?, market = ?, enabled = ?, notes = ?, updated_at = datetime('now', 'localtime')
      WHERE code = ?;
    `).run(name, market, enabled, notes, String(code));
    return this.getStock(code);
  }

  deleteStock(code) {
    const res = this.db.prepare('DELETE FROM stocks WHERE code = ?;').run(String(code));
    return res.changes > 0;
  }

  // ---------------- 实时行情快照 ----------------
  saveQuote(quote) {
    if (!quote || !quote.code) return;
    const stmt = this.db.prepare(`
      INSERT INTO quotes (
        code, trade_time, price, prev_close, open_price, high, low,
        change_pct, volume_hand, amount_wan, turnover_rate, amplitude,
        volume_ratio, float_cap_yi, total_cap_yi, pb
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);
    stmt.run(
      quote.code,
      quote.time || new Date().toISOString(),
      quote.price ?? null,
      quote.prevClose ?? null,
      quote.open ?? null,
      quote.high ?? null,
      quote.low ?? null,
      quote.changePct ?? null,
      quote.volumeHand ?? null,
      quote.amountWan ?? null,
      quote.turnoverRate ?? null,
      quote.amplitude ?? null,
      quote.volumeRatio ?? null,
      quote.floatCapYi ?? null,
      quote.totalCapYi ?? null,
      quote.pb ?? null
    );
  }

  getLatestQuote(code) {
    return this.db.prepare(`
      SELECT * FROM quotes WHERE code = ? ORDER BY trade_time DESC, id DESC LIMIT 1;
    `).get(String(code));
  }

  getQuotesByRange(code, fromTime, toTime, limit = 500) {
    let sql = 'SELECT * FROM quotes WHERE code = ?';
    const params = [String(code)];
    if (fromTime) {
      sql += ' AND trade_time >= ?';
      params.push(fromTime);
    }
    if (toTime) {
      sql += ' AND trade_time <= ?';
      params.push(toTime);
    }
    sql += ' ORDER BY trade_time ASC LIMIT ?;';
    params.push(limit);
    return this.db.prepare(sql).all(...params);
  }

  // ---------------- 资金流向（金额统一按元存储） ----------------
  saveFundFlow(flow) {
    if (!flow || !flow.code || !flow.date) return;
    const stmt = this.db.prepare(`
      INSERT INTO fund_flows (
        code, trade_date, main_net, super_large_net, large_net, mid_net, small_net
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code, trade_date) DO UPDATE SET
        main_net = excluded.main_net,
        super_large_net = excluded.super_large_net,
        large_net = excluded.large_net,
        mid_net = excluded.mid_net,
        small_net = excluded.small_net;
    `);
    stmt.run(
      flow.code,
      flow.date,
      flow.mainNet ?? null,
      flow.superLargeNet ?? null,
      flow.largeNet ?? null,
      flow.midNet ?? null,
      flow.smallNet ?? null
    );
  }

  getFundFlowsByRange(code, fromDate, toDate, limit = 60) {
    let sql = 'SELECT * FROM fund_flows WHERE code = ?';
    const params = [String(code)];
    if (fromDate) {
      sql += ' AND trade_date >= ?';
      params.push(fromDate);
    }
    if (toDate) {
      sql += ' AND trade_date <= ?';
      params.push(toDate);
    }
    sql += ' ORDER BY trade_date ASC LIMIT ?;';
    params.push(limit);
    return this.db.prepare(sql).all(...params);
  }

  // ---------------- 公告入库 ----------------
  saveAnnouncements(list = []) {
    if (!Array.isArray(list) || list.length === 0) return 0;
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO announcements (ann_id, code, title, publish_time, ann_url, raw_json)
      VALUES (?, ?, ?, ?, ?, ?);
    `);
    let count = 0;
    this.db.exec('BEGIN TRANSACTION;');
    try {
      for (const a of list) {
        if (!a.id || !a.code) continue;
        const res = stmt.run(
          String(a.id),
          String(a.code),
          String(a.title || ''),
          String(a.time || ''),
          String(a.url || ''),
          JSON.stringify(a)
        );
        if (res.changes > 0) count++;
      }
      this.db.exec('COMMIT;');
    } catch (e) {
      this.db.exec('ROLLBACK;');
      throw e;
    }
    return count;
  }

  getAnnouncements(code, limit = 50, fromTime = null) {
    let sql = 'SELECT * FROM announcements WHERE 1=1';
    const params = [];
    if (code) {
      sql += ' AND code = ?';
      params.push(String(code));
    }
    if (fromTime) {
      sql += ' AND publish_time >= ?';
      params.push(fromTime);
    }
    sql += ' ORDER BY publish_time DESC LIMIT ?;';
    params.push(limit);
    return this.db.prepare(sql).all(...params);
  }

  // ---------------- 盘后数据（龙虎榜、大宗、两融） ----------------
  savePostMarketData({ code, tradeDate, dataType, summary, detail }) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO post_market_data (code, trade_date, data_type, summary, detail_json)
      VALUES (?, ?, ?, ?, ?);
    `);
    stmt.run(String(code), String(tradeDate), String(dataType), String(summary), JSON.stringify(detail || {}));
  }

  getPostMarketData(code, tradeDate = null, dataType = null, limit = 20) {
    let sql = 'SELECT * FROM post_market_data WHERE code = ?';
    const params = [String(code)];
    if (tradeDate) {
      sql += ' AND trade_date = ?';
      params.push(tradeDate);
    }
    if (dataType) {
      sql += ' AND data_type = ?';
      params.push(dataType);
    }
    sql += ' ORDER BY trade_date DESC, id DESC LIMIT ?;';
    params.push(limit);
    return this.db.prepare(sql).all(...params);
  }

  // ---------------- 事件与去重（黄升红升级推送逻辑） ----------------
  recordEvent({ eventId, code, category, level, time, summary, impact = '中性', source, url = '' }) {
    const LEVEL_RANK = { 绿: 0, 黄: 1, 红: 2 };
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT * FROM events WHERE event_id = ?;').get(eventId);

    if (existing) {
      const oldRank = LEVEL_RANK[existing.level] ?? 0;
      const newRank = LEVEL_RANK[level] ?? 0;
      if (newRank > oldRank) {
        // 级别发生升级（如黄升红），更新并重新触发推送
        this.db.prepare(`
          UPDATE events
          SET level = ?, summary = ?, impact = ?, last_pushed_at = ?
          WHERE event_id = ?;
        `).run(level, summary, impact, now, eventId);
        return { isNew: true, isUpgrade: true, event: { ...existing, level, summary, impact } };
      }
      // 已记录且未升级，直接忽略
      return { isNew: false, isUpgrade: false, event: existing };
    }

    // 新增事件入库
    this.db.prepare(`
      INSERT INTO events (
        event_id, code, category, level, time, summary, impact, source, url, first_pushed_at, last_pushed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `).run(eventId, code, category, level, time, summary, impact, source, url, now, now);

    return {
      isNew: true,
      isUpgrade: false,
      event: { event_id: eventId, code, category, level, time, summary, impact, source, url },
    };
  }

  getEvents({ code, level, category, fromDate, toDate, limit = 100 } = {}) {
    let sql = 'SELECT e.*, s.name as stock_name FROM events e LEFT JOIN stocks s ON e.code = s.code WHERE 1=1';
    const params = [];
    if (code) {
      sql += ' AND e.code = ?';
      params.push(String(code));
    }
    if (level) {
      sql += ' AND e.level = ?';
      params.push(level);
    }
    if (category) {
      sql += ' AND e.category = ?';
      params.push(category);
    }
    if (fromDate) {
      sql += ' AND e.time >= ?';
      params.push(fromDate);
    }
    if (toDate) {
      sql += ' AND e.time <= ?';
      params.push(toDate);
    }
    sql += ' ORDER BY e.time DESC, e.last_pushed_at DESC LIMIT ?;';
    params.push(limit);
    return this.db.prepare(sql).all(...params);
  }

  // ---------------- 管道运行与补偿记录 ----------------
  startPipelineRun({ mode, targetCode = null }) {
    const now = new Date().toISOString();
    const res = this.db.prepare(`
      INSERT INTO pipeline_runs (run_mode, target_code, start_time, status)
      VALUES (?, ?, ?, 'running');
    `).run(mode, targetCode, now);
    return res.lastInsertRowid;
  }

  finishPipelineRun(runId, { status = 'success', issues = [], summary = '' }) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE pipeline_runs
      SET end_time = ?, status = ?, issues_json = ?, summary = ?
      WHERE id = ?;
    `).run(now, status, JSON.stringify(issues || []), summary, runId);
  }

  getRecentRuns(limit = 20) {
    return this.db.prepare(`
      SELECT * FROM pipeline_runs ORDER BY id DESC LIMIT ?;
    `).all(limit);
  }

  // ---------------- 数据清理任务（行情/资金流保留 N 天） ----------------
  pruneOldTimeData(keepDays = 90) {
    const cutoffDate = new Date(Date.now() - keepDays * 86400 * 1000).toISOString().slice(0, 10);
    const delQuotes = this.db.prepare("DELETE FROM quotes WHERE trade_time < ?;").run(cutoffDate);
    const delFlows = this.db.prepare("DELETE FROM fund_flows WHERE trade_date < ?;").run(cutoffDate);
    return { deletedQuotes: delQuotes.changes, deletedFundFlows: delFlows.changes, cutoffDate };
  }

  // ---------------- AI 结构化分析缓存 ----------------
  getAiAnalysis(targetType, targetId, model, promptVer) {
    return this.db.prepare(`
      SELECT * FROM ai_analysis
      WHERE target_type = ? AND target_id = ? AND model = ? AND prompt_ver = ?;
    `).get(targetType, targetId, model, promptVer);
  }

  saveAiAnalysis({ targetType, targetId, model, promptVer, sentiment, summary, confidence = 1.0, rawOutput = '' }) {
    const stmt = this.db.prepare(`
      INSERT INTO ai_analysis (
        target_type, target_id, model, prompt_ver, sentiment, summary, confidence, raw_output
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_type, target_id, model, prompt_ver) DO UPDATE SET
        sentiment = excluded.sentiment,
        summary = excluded.summary,
        confidence = excluded.confidence,
        raw_output = excluded.raw_output;
    `);
    stmt.run(targetType, targetId, model, promptVer, sentiment, summary, confidence, rawOutput);
  }

  // ---------------- 会话与对话消息 ----------------
  createConversation(id, title, stockCode = null) {
    this.db.prepare(`
      INSERT INTO conversations (id, title, stock_code) VALUES (?, ?, ?);
    `).run(id, title, stockCode);
    return this.getConversation(id);
  }

  getConversations(limit = 50) {
    return this.db.prepare(`
      SELECT c.*, s.name as stock_name
      FROM conversations c
      LEFT JOIN stocks s ON c.stock_code = s.code
      ORDER BY c.updated_at DESC LIMIT ?;
    `).all(limit);
  }

  getConversation(id) {
    return this.db.prepare(`
      SELECT c.*, s.name as stock_name
      FROM conversations c
      LEFT JOIN stocks s ON c.stock_code = s.code
      WHERE c.id = ?;
    `).get(id);
  }

  deleteConversation(id) {
    const res = this.db.prepare('DELETE FROM conversations WHERE id = ?;').run(id);
    return res.changes > 0;
  }

  saveMessage({ conversationId, role, content, contextRefs = null, status = 'completed' }) {
    const res = this.db.prepare(`
      INSERT INTO messages (conversation_id, role, content, context_refs, status)
      VALUES (?, ?, ?, ?, ?);
    `).run(conversationId, role, content, contextRefs ? JSON.stringify(contextRefs) : null, status);

    this.db.prepare(`
      UPDATE conversations SET updated_at = datetime('now', 'localtime') WHERE id = ?;
    `).run(conversationId);

    return res.lastInsertRowid;
  }

  getMessages(conversationId, limit = 100) {
    return this.db.prepare(`
      SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC LIMIT ?;
    `).all(conversationId, limit);
  }
}
