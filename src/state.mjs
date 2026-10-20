// 状态管理：用 JSON 文件持久化，记录每只股票的上次检查时间与已推送事件（去重）
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { ROOT } from './config.mjs';

const DEFAULT_STATE_FILE = 'data/state.json';

function statePath(config) {
  const p = config.stateFile || DEFAULT_STATE_FILE;
  return resolve(ROOT, p);
}

export function loadState(config) {
  const p = statePath(config);
  if (!existsSync(p)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

export function saveState(config, state) {
  const p = statePath(config);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2), 'utf-8');
}

function ensureStock(state, code) {
  if (!state[code]) {
    state[code] = { last_success_timestamp: null, pushed_events: [] };
  }
  return state[code];
}

export function getLastTimestamp(state, code) {
  const s = state[code];
  return s ? s.last_success_timestamp : null;
}

export function setLastTimestamp(state, code, ts) {
  ensureStock(state, code).last_success_timestamp = ts;
}

export function getPushedEvents(state, code) {
  const s = state[code];
  return s ? s.pushed_events : [];
}

export function isPushed(state, code, eventId) {
  return getPushedEvents(state, code).some((e) => e.event_id === eventId);
}

/**
 * 记录已推送事件。返回是否为新事件。
 * 若同一 event_id 已存在但 level 升级（红>黄>绿），视为重大进展，允许覆盖并返回 true。
 */
const LEVEL_RANK = { 绿: 0, 黄: 1, 红: 2 };

export function addPushedEvent(state, code, eventId, level) {
  const s = ensureStock(state, code);
  const existing = s.pushed_events.find((e) => e.event_id === eventId);
  const now = new Date().toISOString();
  if (existing) {
    const newRank = LEVEL_RANK[level] ?? 0;
    const oldRank = LEVEL_RANK[existing.level] ?? 0;
    if (newRank > oldRank) {
      existing.level = level;
      existing.pushed_at = now;
      return true; // 级别升级，允许重新推送
    }
    return false; // 已推送且无升级，去重
  }
  s.pushed_events.push({ event_id: eventId, level, pushed_at: now });
  return true;
}

// 清理超过保留天数的历史事件，防止状态文件无限增长
export function pruneOldEvents(state, code, keepDays = 7) {
  const s = state[code];
  if (!s) return;
  const cutoff = Date.now() - keepDays * 86400 * 1000;
  s.pushed_events = s.pushed_events.filter((e) => {
    const t = new Date(e.pushed_at).getTime();
    return !Number.isNaN(t) && t >= cutoff;
  });
}
