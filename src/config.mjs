// 配置加载模块：读取 config.json 并做基础校验
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CONFIG_PATH = resolve(ROOT, 'config.json');

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`配置文件不存在: ${CONFIG_PATH}`);
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  if (!Array.isArray(raw.stocks) || raw.stocks.length === 0) {
    throw new Error('config.json 缺少 stocks 数组');
  }
  for (const s of raw.stocks) {
    if (!s.code || typeof s.code !== 'string') {
      throw new Error(`config.json 标的配置无效，缺少合法的 code: ${JSON.stringify(s)}`);
    }
    if (!s.market || !['sh', 'sz'].includes(s.market)) {
      throw new Error(`config.json 标的 ${s.code} 的 market 必须为 'sh' 或 'sz'`);
    }
  }
  return raw;
}

// 市场代码转各数据源前缀
export function marketPrefix(market) {
  return market === 'sh' ? 'sh' : 'sz';
}

// 东财 secid：沪市 1.xxxxxx，深市 0.xxxxxx
export function eastmoneySecId(stock) {
  return stock.market === 'sh' ? `1.${stock.code}` : `0.${stock.code}`;
}

export { ROOT };
