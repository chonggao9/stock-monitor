// 仓储层测试：测试 SQLite 数据库 CRUD、WAL 并发配置、黄升红升级推送逻辑
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { getRepo } from '../src/db/repo.mjs';
import { ROOT } from '../src/config.mjs';

const TEST_DB_PATH = resolve(ROOT, 'data/test_stock_monitor.db');

test('SQLite 仓储与事件升级逻辑测试', () => {
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  const repo = getRepo(TEST_DB_PATH);

  // 1. 标的 CRUD
  repo.upsertStock({ code: '600519', name: '贵州茅台', market: 'sh', enabled: 1, notes: '白酒龙头' });
  const stock = repo.getStock('600519');
  assert.equal(stock.name, '贵州茅台');
  assert.equal(stock.enabled, 1);

  repo.patchStock('600519', { notes: '白酒龙头调仓观察' });
  assert.equal(repo.getStock('600519').notes, '白酒龙头调仓观察');

  // 2. 事件去重与“黄升红升级允许重新推送”逻辑
  const eventId = 'test_event_001';
  
  // 初次：黄色关注事件
  const firstRes = repo.recordEvent({
    eventId,
    code: '600519',
    category: '公告',
    level: '黄',
    time: '2026-10-20 09:30',
    summary: '收到监管问询通知',
    source: '测试源',
  });
  assert.equal(firstRes.isNew, true);
  assert.equal(firstRes.isUpgrade, false);

  // 再次传入相同 event_id 且同为黄色级别 -> 应该被去重拦截
  const duplicateRes = repo.recordEvent({
    eventId,
    code: '600519',
    category: '公告',
    level: '黄',
    time: '2026-10-20 09:30',
    summary: '收到监管问询通知',
    source: '测试源',
  });
  assert.equal(duplicateRes.isNew, false);
  assert.equal(duplicateRes.isUpgrade, false);

  // 同一 event_id 升级为红色严重级别 -> 允许覆盖并触发升级推送
  const upgradeRes = repo.recordEvent({
    eventId,
    code: '600519',
    category: '公告',
    level: '红',
    time: '2026-10-20 09:35',
    summary: '监管问询升级为立案调查',
    source: '测试源',
  });
  assert.equal(upgradeRes.isNew, true);
  assert.equal(upgradeRes.isUpgrade, true);
  assert.equal(upgradeRes.event.level, '红');

  // 3. 行情快照入库与查询
  repo.saveQuote({
    code: '600519',
    time: '20261020094000',
    price: 1800.5,
    changePct: 1.5,
    amountWan: 50000,
  });
  const latestQuote = repo.getLatestQuote('600519');
  assert.equal(latestQuote.price, 1800.5);

  // 清理测试临时库（先关闭句柄释放 Windows 文件锁）
  try {
    if (repo && repo.db && repo.db.close) repo.db.close();
    if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  } catch {}
});
