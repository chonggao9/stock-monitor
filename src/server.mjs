// 内置 HTTP Web 服务：提供 RESTful API 与静态页面托管
// 严格安全规范：仅支持 Authorization: Bearer <TOKEN> Header 鉴权，未设置 AUTH_TOKEN 时拒绝启动
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRepo } from './db/repo.mjs';
import { runCompensation } from './compensate.mjs';
import { analyzeEventWithCache } from './llm.mjs';
import { handleConversationChat } from './chat.mjs';
import { detectStockMarketAndName } from './fetchers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '../public');

// MIME 映射
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  });
  res.end(JSON.stringify(data));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 校验 Authorization Header
 */
function checkAuth(req, expectedToken) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return false;
  }
  const token = authHeader.slice(7).trim();
  return token === expectedToken;
}

export function startServer({ port = 3000, host = '127.0.0.1' } = {}) {
  const authToken = process.env.AUTH_TOKEN;
  if (!authToken || !authToken.trim()) {
    console.error('===========================================================');
    console.error('【安全致命错误】未设置环境变量 AUTH_TOKEN，Web 服务拒绝启动！');
    console.error('请在环境变量中配置 AUTH_TOKEN=你的强密码 后再启动服务。');
    console.error('===========================================================');
    process.exit(1);
  }

  const repo = getRepo();

  const server = createServer(async (req, res) => {
    // 跨域预检处理
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      });
      return res.end();
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // 1. 静态资源托管（不需要 Token 即可访问登录/管理单页）
    if (!pathname.startsWith('/api/')) {
      let filePath = pathname === '/' ? resolve(PUBLIC_DIR, 'index.html') : resolve(PUBLIC_DIR, pathname.slice(1));
      if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      if (existsSync(filePath)) {
        const ext = extname(filePath).toLowerCase();
        const mime = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        return res.end(readFileSync(filePath));
      }
      // 单页 SPA 回退
      const indexHtml = resolve(PUBLIC_DIR, 'index.html');
      if (existsSync(indexHtml)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(readFileSync(indexHtml));
      }
      res.writeHead(404);
      return res.end('Not Found');
    }

    // 2. 所有 /api/* 接口严格执行 Bearer Token 鉴权
    if (!checkAuth(req, authToken)) {
      return sendJson(res, 401, {
        error: 'Unauthorized',
        message: '缺少有效凭证。请在请求头设置 Authorization: Bearer <AUTH_TOKEN>',
      });
    }

    // 3. API 路由分发
    try {
      // ---- 标的管理 ----
      if (pathname === '/api/stocks' && req.method === 'GET') {
        const stocks = repo.getAllStocks();
        return sendJson(res, 200, { ok: true, data: stocks });
      }

      if (pathname === '/api/stocks' && req.method === 'POST') {
        const body = await parseJsonBody(req);
        if (!body.code) {
          return sendJson(res, 400, { ok: false, error: '缺少股票代码 code' });
        }
        let name = body.name;
        let market = body.market;
        let initialQuote = null;

        // 若未提供名称或市场，自动根据代码联网查询校验
        if (!name || !market) {
          try {
            const detected = await detectStockMarketAndName(body.code);
            name = detected.name;
            market = detected.market;
            initialQuote = detected.initialQuote;
          } catch (err) {
            return sendJson(res, 400, { ok: false, error: err.message });
          }
        }

        const updated = repo.upsertStock({
          code: body.code,
          name,
          market,
          enabled: body.enabled !== undefined ? body.enabled : 1,
          notes: body.notes || '',
        });

        // 存入初始行情快照
        if (initialQuote) {
          repo.saveQuote(initialQuote);
        }

        // 新股票入库时自动启动历史数据初始化（补齐近 30 天公告、资金流、盘后交易）
        const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);
        runCompensation({
          code: body.code,
          startDate: thirtyDaysAgo,
          modules: ['announcements', 'fund_flow', 'post_market'],
        }).catch((err) => console.error(`[新股数据初始化异常 ${body.code}]:`, err));

        return sendJson(res, 200, {
          ok: true,
          data: updated,
          message: `标的添加成功！已自动识别为 [${name} (${market.toUpperCase()})]，并完成首轮数据初始化。`,
        });
      }

      const matchStockCode = pathname.match(/^\/api\/stocks\/([0-9a-zA-Z]+)$/);
      if (matchStockCode && req.method === 'PATCH') {
        const code = matchStockCode[1];
        const body = await parseJsonBody(req);
        const patched = repo.patchStock(code, body);
        if (!patched) return sendJson(res, 404, { ok: false, error: '股票未找到' });
        return sendJson(res, 200, { ok: true, data: patched });
      }

      if (matchStockCode && req.method === 'DELETE') {
        const code = matchStockCode[1];
        const ok = repo.deleteStock(code);
        return sendJson(res, 200, { ok });
      }

      // ---- 时序行情与资金流 ----
      const matchQuotes = pathname.match(/^\/api\/stocks\/([0-9a-zA-Z]+)\/quotes$/);
      if (matchQuotes && req.method === 'GET') {
        const code = matchQuotes[1];
        const from = parsedUrl.searchParams.get('from');
        const to = parsedUrl.searchParams.get('to');
        const quotes = repo.getQuotesByRange(code, from, to, 300);
        return sendJson(res, 200, { ok: true, data: quotes });
      }

      const matchFundFlow = pathname.match(/^\/api\/stocks\/([0-9a-zA-Z]+)\/fund-flow$/);
      if (matchFundFlow && req.method === 'GET') {
        const code = matchFundFlow[1];
        const from = parsedUrl.searchParams.get('from');
        const to = parsedUrl.searchParams.get('to');
        const flows = repo.getFundFlowsByRange(code, from, to, 60);
        return sendJson(res, 200, { ok: true, data: flows });
      }

      const matchPostMarket = pathname.match(/^\/api\/stocks\/([0-9a-zA-Z]+)\/post-market$/);
      if (matchPostMarket && req.method === 'GET') {
        const code = matchPostMarket[1];
        const type = parsedUrl.searchParams.get('type');
        const data = repo.getPostMarketData(code, null, type, 30);
        return sendJson(res, 200, { ok: true, data });
      }

      // ---- 事件时间线 ----
      if (pathname === '/api/events' && req.method === 'GET') {
        const code = parsedUrl.searchParams.get('code');
        const level = parsedUrl.searchParams.get('level');
        const category = parsedUrl.searchParams.get('category');
        const fromDate = parsedUrl.searchParams.get('from');
        const toDate = parsedUrl.searchParams.get('to');
        const limit = parseInt(parsedUrl.searchParams.get('limit') || '100', 10);
        const events = repo.getEvents({ code, level, category, fromDate, toDate, limit });
        return sendJson(res, 200, { ok: true, data: events });
      }

      // ---- 手动触发单条事件的 AI 分析重算 ----
      const matchAnalyze = pathname.match(/^\/api\/events\/(.+)\/analyze$/);
      if (matchAnalyze && req.method === 'POST') {
        const eventId = decodeURIComponent(matchAnalyze[1]);
        const events = repo.getEvents({ limit: 1000 });
        const target = events.find((e) => e.event_id === eventId);
        if (!target) return sendJson(res, 404, { ok: false, error: '事件未找到' });

        const result = await analyzeEventWithCache(repo, {
          eventId: target.event_id,
          title: target.summary,
          category: target.category,
          ruleLevel: target.level,
        });

        return sendJson(res, 200, { ok: true, data: result });
      }

      // ---- 数据获取补偿接口（重点） ----
      if (pathname === '/api/compensate' && req.method === 'POST') {
        const body = await parseJsonBody(req);
        // 异步启动补偿任务
        runCompensation({
          code: body.code || null,
          startDate: body.startDate || null,
          endDate: body.endDate || null,
          modules: body.modules || ['announcements', 'fund_flow', 'post_market'],
        }).catch((e) => console.error('[API 补偿错误]:', e));

        return sendJson(res, 202, {
          ok: true,
          message: '数据获取补偿任务已在后台启动，可在运行记录中查看进度',
        });
      }

      // ---- 运行记录看板 ----
      if (pathname === '/api/runs' && req.method === 'GET') {
        const limit = parseInt(parsedUrl.searchParams.get('limit') || '30', 10);
        const runs = repo.getRecentRuns(limit);
        return sendJson(res, 200, { ok: true, data: runs });
      }

      // ---- 会话与 AI 对话 ----
      if (pathname === '/api/conversations' && req.method === 'GET') {
        const convs = repo.getConversations();
        return sendJson(res, 200, { ok: true, data: convs });
      }

      if (pathname === '/api/conversations' && req.method === 'POST') {
        const body = await parseJsonBody(req);
        const id = 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        const title = body.title || (body.stockCode ? `关于 ${body.stockCode} 的研讨` : '综合研判对话');
        const conv = repo.createConversation(id, title, body.stockCode || null);
        return sendJson(res, 200, { ok: true, data: conv });
      }

      const matchConv = pathname.match(/^\/api\/conversations\/([a-zA-Z0-9_-]+)$/);
      if (matchConv && req.method === 'DELETE') {
        const id = matchConv[1];
        const ok = repo.deleteConversation(id);
        return sendJson(res, 200, { ok });
      }

      const matchMessages = pathname.match(/^\/api\/conversations\/([a-zA-Z0-9_-]+)\/messages$/);
      if (matchMessages && req.method === 'GET') {
        const convId = matchMessages[1];
        const messages = repo.getMessages(convId);
        return sendJson(res, 200, { ok: true, data: messages });
      }

      if (matchMessages && req.method === 'POST') {
        const convId = matchMessages[1];
        const body = await parseJsonBody(req);
        if (!body.content || !body.content.trim()) {
          return sendJson(res, 400, { ok: false, error: '消息内容不能为空' });
        }
        const isStream = parsedUrl.searchParams.get('stream') === 'true';
        return await handleConversationChat(req, res, repo, convId, body.content.trim(), isStream);
      }

      // 404
      return sendJson(res, 404, { ok: false, error: 'Endpoint Not Found' });
    } catch (err) {
      console.error('[Web API 处理异常]:', err);
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  });

  server.listen(port, host, () => {
    console.log(`\n===========================================================`);
    console.log(`[Web服务] 股票监控平台运行中: http://${host}:${port}`);
    console.log(`[安全鉴权] 严格鉴权模式启用，Token: ${authToken.slice(0, 3)}***${authToken.slice(-2)}`);
    console.log(`===========================================================\n`);
  });

  return server;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/server.mjs')) {
  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '127.0.0.1';
  startServer({ port, host });
}
