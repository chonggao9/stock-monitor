// 前端核心驱动：原生 ESM，零第三方依赖，纯离线 SVG 图表绘制，严格 Header 鉴权

// ---------------- 鉴权与 API 封装 ----------------
let AUTH_TOKEN = localStorage.getItem('stock_monitor_token') || '';

function updateAuthUI() {
  const statusEl = document.getElementById('authStatusText');
  if (AUTH_TOKEN) {
    statusEl.textContent = '凭证已设置';
    statusEl.className = 'auth-text ok';
  } else {
    statusEl.textContent = '未设置密钥';
    statusEl.className = 'auth-text';
  }
}

async function apiFetch(path, options = {}) {
  if (!AUTH_TOKEN) {
    showTokenModal();
    throw new Error('未设置 AUTH_TOKEN');
  }
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${AUTH_TOKEN}`,
    ...(options.headers || {}),
  };

  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    showTokenModal();
    throw new Error('鉴权失败: Token 无效或已过期');
  }
  if (!res.ok) {
    const errJson = await res.json().catch(() => ({}));
    throw new Error(errJson.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function showTokenModal() {
  document.getElementById('tokenModal').classList.add('active');
  document.getElementById('tokenInput').value = AUTH_TOKEN;
}
function hideTokenModal() {
  document.getElementById('tokenModal').classList.remove('active');
}

// ---------------- 导航 Tab 切换 ----------------
function initNavigation() {
  const navBtns = document.querySelectorAll('.nav-btn');
  navBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      navBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      document.querySelectorAll('.view-panel').forEach((p) => p.classList.remove('active'));
      const activePanel = document.getElementById(`view-${tab}`);
      if (activePanel) activePanel.classList.add('active');

      // 切换到对应标签时触发数据加载
      if (tab === 'stocks') loadStocks();
      if (tab === 'timeline') loadEvents();
      if (tab === 'detail') loadDetailStockList();
      if (tab === 'compensate') { loadCompensateOptions(); loadRuns(); }
      if (tab === 'chat') loadConversations();
    });
  });
}

// ---------------- 模块一: 股票管理 ----------------
let cachedStocks = [];

async function loadStocks() {
  const tbody = document.getElementById('stocksTableBody');
  try {
    const res = await apiFetch('/api/stocks');
    cachedStocks = res.data || [];
    renderStocksTable(cachedStocks);
    updateStockSelects(cachedStocks);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="loading-cell" style="color:#f87171;">加载失败: ${err.message}</td></tr>`;
  }
}

function renderStocksTable(stocks) {
  const tbody = document.getElementById('stocksTableBody');
  if (stocks.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="loading-cell">暂无监控标的，请点击右上角添加</td></tr>';
    return;
  }
  tbody.innerHTML = stocks
    .map(
      (s) => `
    <tr>
      <td>
        <label class="switch">
          <input type="checkbox" ${s.enabled ? 'checked' : ''} onchange="window.toggleStockEnabled('${s.code}', this.checked)">
          <span class="slider"></span>
        </label>
      </td>
      <td><strong>${s.code}</strong></td>
      <td>${s.name}</td>
      <td><span class="tag ${s.market === 'sh' ? 'tag-red' : 'tag-yellow'}">${s.market.toUpperCase()}</span></td>
      <td>
        <span id="note-txt-${s.code}">${s.notes || '-'}</span>
        <button class="btn-sm" style="margin-left:6px;padding:1px 5px;" onclick="window.editStockNotes('${s.code}', '${s.notes || ''}')">修改</button>
      </td>
      <td style="color:var(--text-muted);font-size:0.8rem;">${s.updated_at || s.created_at}</td>
      <td>
        <button class="btn-danger btn-sm" onclick="window.deleteStock('${s.code}', '${s.name}')">删除</button>
      </td>
    </tr>
  `
    )
    .join('');
}

window.toggleStockEnabled = async (code, enabled) => {
  try {
    await apiFetch(`/api/stocks/${code}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: enabled ? 1 : 0 }),
    });
  } catch (err) {
    alert(`更新状态失败: ${err.message}`);
    loadStocks();
  }
};

window.editStockNotes = async (code, currentNote) => {
  const newNote = prompt(`修改标的 [${code}] 的备注:`, currentNote);
  if (newNote === null) return;
  try {
    await apiFetch(`/api/stocks/${code}`, {
      method: 'PATCH',
      body: JSON.stringify({ notes: newNote.trim() }),
    });
    loadStocks();
  } catch (err) {
    alert(`修改备注失败: ${err.message}`);
  }
};

window.deleteStock = async (code, name) => {
  if (!confirm(`确定要从监控列表中删除 [${code}] ${name} 吗？`)) return;
  try {
    await apiFetch(`/api/stocks/${code}`, { method: 'DELETE' });
    loadStocks();
  } catch (err) {
    alert(`删除失败: ${err.message}`);
  }
};

function updateStockSelects(stocks) {
  const selects = ['eventStockFilter', 'detailStockSelect', 'compStockSelect'];
  selects.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const curVal = el.value;
    const isFilter = id === 'eventStockFilter' || id === 'compStockSelect';
    let html = isFilter ? '<option value="">全部标的</option>' : '';
    html += stocks.map((s) => `<option value="${s.code}">${s.name} (${s.code})</option>`).join('');
    el.innerHTML = html;
    if (curVal) el.value = curVal;
  });
}

// ---------------- 模块二: 事件时间线 ----------------
async function loadEvents() {
  const container = document.getElementById('eventsTimelineContainer');
  container.innerHTML = '<div class="loading-cell">正在拉取事件时间线...</div>';
  const code = document.getElementById('eventStockFilter').value;
  const level = document.getElementById('eventLevelFilter').value;
  let url = '/api/events?limit=80';
  if (code) url += `&code=${encodeURIComponent(code)}`;
  if (level) url += `&level=${encodeURIComponent(level)}`;

  try {
    const res = await apiFetch(url);
    const events = res.data || [];
    if (events.length === 0) {
      container.innerHTML = '<div class="card" style="text-align:center;color:var(--text-muted);">暂无符合筛选条件的事件记录</div>';
      return;
    }
    container.innerHTML = events
      .map((e) => {
        const levelClass = e.level === '红' ? 'tag-red' : e.level === '黄' ? 'tag-yellow' : 'tag-green';
        const impactClass = e.impact === '利好' ? 'tag-bull' : e.impact === '利空' ? 'tag-bear' : '';
        return `
        <div class="timeline-item level-${e.level}">
          <div class="timeline-meta">
            <span class="tag ${levelClass}">${e.level}级</span>
            <strong>${e.stock_name || e.code} (${e.code})</strong>
            <span>${e.time}</span>
            <span>来源: ${e.source}</span>
            ${e.impact ? `<span class="tag ${impactClass}">${e.impact}</span>` : ''}
          </div>
          <div class="timeline-content">${e.summary}</div>
          <div class="timeline-footer">
            <div>
              ${e.url ? `<a href="${e.url}" target="_blank" rel="noopener noreferrer">查看巨潮原文 ↗</a>` : ''}
            </div>
            <button class="btn-sm" onclick="window.reAnalyzeEvent('${encodeURIComponent(e.event_id)}')">AI 重新研判</button>
          </div>
        </div>
      `;
      })
      .join('');
  } catch (err) {
    container.innerHTML = `<div class="card" style="color:#f87171;">拉取事件失败: ${err.message}</div>`;
  }
}

// 绑定时间线筛选与刷新事件
document.getElementById('eventStockFilter')?.addEventListener('change', loadEvents);
document.getElementById('eventLevelFilter')?.addEventListener('change', loadEvents);
document.getElementById('refreshEventsBtn')?.addEventListener('click', loadEvents);

window.reAnalyzeEvent = async (encodedId) => {
  try {
    const res = await apiFetch(`/api/events/${encodedId}/analyze`, { method: 'POST' });
    if (res.ok) {
      alert(`AI 重新研判完成！\n情绪: ${res.data?.sentiment || '未知'}\n摘要: ${res.data?.summary || '无'}`);
      loadEvents();
    }
  } catch (err) {
    alert(`分析失败: ${err.message}`);
  }
};

// ---------------- 模块三: 个股详情与极简内联 SVG 图表 ----------------
async function loadDetailStockList() {
  if (cachedStocks.length === 0) await loadStocks();
  const select = document.getElementById('detailStockSelect');
  if (select.options.length > 0 && !select.value) {
    select.selectedIndex = 0;
  }
  if (select.value) loadStockDetail(select.value);
}

document.getElementById('detailStockSelect').addEventListener('change', (e) => {
  loadStockDetail(e.target.value);
});

async function loadStockDetail(code) {
  if (!code) return;
  const quoteCard = document.getElementById('quoteSummaryCard');
  quoteCard.innerHTML = '<div class="loading-cell">正在获取行情快照...</div>';

  try {
    const [quotesRes, flowsRes, postRes] = await Promise.all([
      apiFetch(`/api/stocks/${code}/quotes`),
      apiFetch(`/api/stocks/${code}/fund-flow`),
      apiFetch(`/api/stocks/${code}/post-market`),
    ]);

    const quotes = quotesRes.data || [];
    const flows = flowsRes.data || [];
    const postData = postRes.data || [];

    // 1. 行情看板
    const latest = quotes[quotes.length - 1];
    if (latest) {
      const isUp = (latest.change_pct ?? 0) >= 0;
      quoteCard.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <h3>${latest.code} 最新报价指标</h3>
            <span style="font-size:0.8rem;color:var(--text-muted);">快照时间: ${latest.trade_time}</span>
          </div>
          <div style="font-size:1.75rem;font-weight:700;color:${isUp ? 'var(--danger)' : 'var(--success)'};">
            ${latest.price ?? '-'} <span style="font-size:1rem;">(${isUp ? '+' : ''}${latest.change_pct ?? 0}%)</span>
          </div>
        </div>
        <div class="grid">
          <div class="stat-box"><div class="stat-label">今开 / 昨收</div><div class="stat-val">${latest.open_price ?? '-'} / ${latest.prev_close ?? '-'}</div></div>
          <div class="stat-box"><div class="stat-label">最高 / 最低</div><div class="stat-val">${latest.high ?? '-'} / ${latest.low ?? '-'}</div></div>
          <div class="stat-box"><div class="stat-label">成交额 (万元)</div><div class="stat-val">${latest.amount_wan ?? '-'}</div></div>
          <div class="stat-box"><div class="stat-label">换手率</div><div class="stat-val">${latest.turnover_rate ? latest.turnover_rate + '%' : '-'}</div></div>
          <div class="stat-box"><div class="stat-label">量比</div><div class="stat-val">${latest.volume_ratio ?? '-'}</div></div>
          <div class="stat-box"><div class="stat-label">流通市值 (亿元)</div><div class="stat-val">${latest.float_cap_yi ?? '-'}</div></div>
        </div>
      `;
    } else {
      quoteCard.innerHTML = '<div class="loading-cell">暂无入库的实时行情数据</div>';
    }

    // 2. 渲染极简价格走势折线图 (原生内联 SVG，零打包零 CDN)
    renderSvgPriceChart(quotes);

    // 3. 渲染极简资金净额红绿柱图 (原生内联 SVG)
    renderSvgFundFlowChart(flows);

    // 4. 盘后交易列表
    const postContainer = document.getElementById('postMarketContainer');
    if (postData.length === 0) {
      postContainer.innerHTML = '<div style="color:var(--text-muted);padding:1rem;">暂无近期盘后披露数据（龙虎榜、大宗交易、融资融券）</div>';
    } else {
      postContainer.innerHTML = postData
        .map(
          (p) => `
        <div style="padding:0.6rem 0;border-bottom:1px solid var(--border-color);display:flex;justify-content:space-between;">
          <div>
            <span class="tag tag-yellow">${p.data_type.toUpperCase()}</span>
            <strong style="margin-left:6px;">${p.trade_date}</strong>
            <span style="margin-left:10px;">${p.summary}</span>
          </div>
        </div>
      `
        )
        .join('');
    }
  } catch (err) {
    quoteCard.innerHTML = `<div style="color:#f87171;">数据加载失败: ${err.message}</div>`;
  }
}

function renderSvgPriceChart(quotes) {
  const container = document.getElementById('priceChartContainer');
  if (!quotes || quotes.length === 0) {
    container.innerHTML = '<span style="color:var(--text-muted);">暂无入库行情快照，请先启动采集或触发补偿</span>';
    return;
  }
  const validQuotes = quotes.filter((q) => typeof q.price === 'number' && !Number.isNaN(q.price));
  if (validQuotes.length === 0) {
    container.innerHTML = '<span style="color:var(--text-muted);">行情快照数据为空</span>';
    return;
  }
  const prices = validQuotes.map((q) => q.price);
  const W = 500;
  const H = 200;
  const pad = 30;

  if (prices.length === 1) {
    const p = prices[0];
    const y = H / 2;
    container.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}">
        <line x1="${pad}" y1="${y}" x2="${W - pad}" y2="${y}" stroke="#38bdf8" stroke-dasharray="4,4" stroke-width="1.5"/>
        <circle cx="${W / 2}" cy="${y}" r="5" fill="#38bdf8"/>
        <text x="${W / 2}" y="${y - 12}" fill="#38bdf8" font-size="12" font-weight="bold" text-anchor="middle">现价: ${p.toFixed(2)}</text>
        <text x="${W / 2}" y="${y + 20}" fill="#94a3b8" font-size="10" text-anchor="middle">(已记录 1 条快照，下轮轮询将连成走势折线)</text>
      </svg>
    `;
    return;
  }

  const min = Math.min(...prices) * 0.998;
  const max = Math.max(...prices) * 1.002;
  const range = max - min || 1;

  const points = prices.map((p, i) => {
    const x = pad + (i / (prices.length - 1)) * (W - pad * 2);
    const y = H - pad - ((p - min) / range) * (H - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const polylineStr = points.join(' ');
  const latestPrice = prices[prices.length - 1];
  const firstPrice = prices[0];
  const strokeColor = latestPrice >= firstPrice ? '#ef4444' : '#10b981';

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}">
      <!-- 网格与标尺 -->
      <line x1="${pad}" y1="${pad}" x2="${W - pad}" y2="${pad}" stroke="#334155" stroke-dasharray="2,2"/>
      <text x="${W - pad}" y="${pad - 4}" fill="#94a3b8" font-size="10" text-anchor="end">${max.toFixed(2)}</text>
      <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#334155"/>
      <text x="${W - pad}" y="${H - pad + 14}" fill="#94a3b8" font-size="10" text-anchor="end">${min.toFixed(2)}</text>
      <!-- 走势折线 -->
      <polyline fill="none" stroke="${strokeColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" points="${polylineStr}"/>
      <circle cx="${points[points.length - 1].split(',')[0]}" cy="${points[points.length - 1].split(',')[1]}" r="4" fill="${strokeColor}"/>
    </svg>
  `;
}

// 极简 SVG 主力资金柱状图绘制 (红正绿负柱，~45行纯原生代码)
function renderSvgFundFlowChart(flows) {
  const container = document.getElementById('fundFlowChartContainer');
  if (!flows || flows.length === 0) {
    container.innerHTML = '<span style="color:var(--text-muted);">暂无时序资金流向数据</span>';
    return;
  }
  const slice = flows.slice(-25); // 最多看近 25 日
  const values = slice.map((f) => (f.main_net || 0) / 10000); // 转为万元
  const maxAbs = Math.max(...values.map(Math.abs), 100);
  const W = 500;
  const H = 200;
  const pad = 25;
  const zeroY = H / 2;
  const barWidth = Math.max(4, Math.floor((W - pad * 2) / slice.length) - 4);

  const bars = slice.map((f, i) => {
    const val = values[i];
    const x = pad + i * ((W - pad * 2) / slice.length);
    const barH = (Math.abs(val) / maxAbs) * (H / 2 - pad);
    const y = val >= 0 ? zeroY - barH : zeroY;
    const color = val >= 0 ? '#ef4444' : '#10b981';
    return `<rect x="${x}" y="${y}" width="${barWidth}" height="${Math.max(2, barH)}" fill="${color}" rx="2"/>`;
  });

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}">
      <!-- 零轴基线 -->
      <line x1="${pad}" y1="${zeroY}" x2="${W - pad}" y2="${zeroY}" stroke="#475569" stroke-width="1.5"/>
      <text x="${pad}" y="${pad}" fill="#94a3b8" font-size="10">+${(maxAbs / 10000).toFixed(1)}亿</text>
      <text x="${pad}" y="${H - 5}" fill="#94a3b8" font-size="10">-${(maxAbs / 10000).toFixed(1)}亿</text>
      <!-- 柱体 -->
      ${bars.join('')}
    </svg>
  `;
}

// ---------------- 模块四: 数据补偿与系统状态 (重点功能) ----------------
function loadCompensateOptions() {
  if (cachedStocks.length > 0) updateStockSelects(cachedStocks);
}

document.getElementById('triggerCompBtn').addEventListener('click', async () => {
  const stockCode = document.getElementById('compStockSelect').value;
  const days = parseInt(document.getElementById('compDaysSelect').value, 10);
  const modules = [];
  if (document.getElementById('compAnn').checked) modules.push('announcements');
  if (document.getElementById('compFlow').checked) modules.push('fund_flow');
  if (document.getElementById('compPost').checked) modules.push('post_market');

  if (modules.length === 0) {
    alert('请至少勾选一个需要补偿的数据模块！');
    return;
  }

  const tip = document.getElementById('compStatusTip');
  tip.textContent = '正在发起后台定向补偿任务，请稍候...';

  const startDate = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
  try {
    const res = await apiFetch('/api/compensate', {
      method: 'POST',
      body: JSON.stringify({
        code: stockCode || null,
        startDate,
        modules,
      }),
    });
    tip.textContent = `✅ ${res.message}`;
    setTimeout(loadRuns, 2000);
  } catch (err) {
    tip.textContent = `❌ 发起补偿失败: ${err.message}`;
  }
});

async function loadRuns() {
  const tbody = document.getElementById('runsTableBody');
  try {
    const res = await apiFetch('/api/runs?limit=15');
    const runs = res.data || [];
    if (runs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="loading-cell">暂无执行流水</td></tr>';
      return;
    }
    tbody.innerHTML = runs
      .map((r) => {
        const issues = JSON.parse(r.issues_json || '[]');
        const statusClass = r.status === 'success' ? 'tag-green' : r.status === 'partial' ? 'tag-yellow' : 'tag-red';
        return `
        <tr>
          <td>#${r.id}</td>
          <td><span class="tag tag-yellow">${r.run_mode}</span></td>
          <td>${r.target_code || '全部标的'}</td>
          <td style="font-size:0.8rem;">${r.start_time ? r.start_time.replace('T', ' ').slice(0, 19) : '-'}</td>
          <td>${r.end_time ? '已完成' : '运行中'}</td>
          <td><span class="tag ${statusClass}">${r.status}</span></td>
          <td>
            <div>${r.summary || '无'}</div>
            ${issues.length ? `<div style="color:#f87171;font-size:0.75rem;margin-top:2px;">异常: ${issues.join('; ')}</div>` : ''}
          </td>
        </tr>
      `;
      })
      .join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="loading-cell" style="color:#f87171;">获取流水失败: ${err.message}</td></tr>`;
  }
}

// ---------------- 模块五: AI 对话舱 ----------------
let currentConvId = null;

async function loadConversations() {
  const listEl = document.getElementById('convList');
  listEl.innerHTML = '<div class="loading-cell">正在加载会话...</div>';
  try {
    const res = await apiFetch('/api/conversations');
    const convs = res.data || [];
    if (convs.length === 0) {
      listEl.innerHTML = '<div style="color:var(--text-muted);padding:1rem;font-size:0.8rem;">暂无历史会话，请点击右上角新建</div>';
      return;
    }
    listEl.innerHTML = convs
      .map(
        (c) => `
      <div class="conv-item ${c.id === currentConvId ? 'active' : ''}" onclick="window.selectConversation('${c.id}')">
        <div>
          <div style="font-weight:600;">${c.title}</div>
          <div style="font-size:0.75rem;color:var(--text-muted);">${c.stock_code ? `标的: ${c.stock_name || c.stock_code}` : '全局会话'}</div>
        </div>
        <button class="btn-sm btn-danger" style="padding:1px 5px;" onclick="event.stopPropagation();window.deleteConversation('${c.id}')">×</button>
      </div>
    `
      )
      .join('');

    if (!currentConvId && convs.length > 0) {
      window.selectConversation(convs[0].id);
    }
  } catch (err) {
    listEl.innerHTML = `<div style="color:#f87171;padding:1rem;">加载失败: ${err.message}</div>`;
  }
}

window.selectConversation = async (id) => {
  currentConvId = id;
  loadConversations();
  const msgArea = document.getElementById('messagesArea');
  msgArea.innerHTML = '<div class="loading-cell">正在加载会话历史...</div>';

  try {
    const res = await apiFetch(`/api/conversations/${id}/messages`);
    const msgs = res.data || [];
    renderMessages(msgs);
  } catch (err) {
    msgArea.innerHTML = `<div style="color:#f87171;">拉取消息失败: ${err.message}</div>`;
  }
};

function renderMessages(msgs) {
  const msgArea = document.getElementById('messagesArea');
  if (msgs.length === 0) {
    msgArea.innerHTML = `
      <div class="welcome-box">
        <p>💡 对话已建立。请输入你关注的问题，AI 将自动调取该标的最新行情与近 7 天公告事件进行研判。</p>
      </div>
    `;
    return;
  }
  msgArea.innerHTML = msgs
    .map((m) => {
      const isUser = m.role === 'user';
      return `
      <div class="msg ${isUser ? 'user' : 'assistant'}">
        <div>${escapeHtml(m.content)}</div>
        ${m.context_refs ? `<div class="msg-refs">📌 已自动对齐最新行情与时序披露事实</div>` : ''}
      </div>
    `;
    })
    .join('');
  msgArea.scrollTop = msgArea.scrollHeight;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}

document.getElementById('newConvBtn').addEventListener('click', async () => {
  const stockCode = prompt('如需绑定特定标的，请输入股票代码（直接留空则为全局综合对话）：');
  if (stockCode === null) return;
  try {
    const res = await apiFetch('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ stockCode: stockCode.trim() || null }),
    });
    if (res.ok) {
      currentConvId = res.data.id;
      loadConversations();
      window.selectConversation(currentConvId);
    }
  } catch (err) {
    alert(`新建会话失败: ${err.message}`);
  }
});

window.deleteConversation = async (id) => {
  if (!confirm('确定删除该会话记录吗？')) return;
  try {
    await apiFetch(`/api/conversations/${id}`, { method: 'DELETE' });
    if (currentConvId === id) currentConvId = null;
    loadConversations();
  } catch (err) {
    alert(`删除失败: ${err.message}`);
  }
};

// 发送对话消息（使用 fetch 带 Header 读取 SSE 流式返回，杜绝 EventSource 无法自定义 Header 的缺陷）
document.getElementById('sendChatBtn').addEventListener('click', sendChatMessage);
document.getElementById('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

async function sendChatMessage() {
  if (!currentConvId) {
    alert('请先新建或选择一个会话！');
    return;
  }
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  const msgArea = document.getElementById('messagesArea');
  // 立即在前端追加用户消息气泡
  const userBubble = document.createElement('div');
  userBubble.className = 'msg user';
  userBubble.textContent = text;
  msgArea.appendChild(userBubble);

  // 预置助手回复气泡
  const botBubble = document.createElement('div');
  botBubble.className = 'msg assistant';
  botBubble.innerHTML = '<span style="color:var(--text-muted);">正在调用模型并注入动态行情事实...</span>';
  msgArea.appendChild(botBubble);
  msgArea.scrollTop = msgArea.scrollHeight;

  try {
    const res = await fetch(`/api/conversations/${currentConvId}/messages?stream=true`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify({ content: text }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let fullReply = '';
    botBubble.innerHTML = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        if (line.includes('[DONE]')) continue;
        try {
          const json = JSON.parse(line.slice(5).trim());
          if (json.delta) {
            fullReply += json.delta;
            botBubble.innerHTML = escapeHtml(fullReply);
            msgArea.scrollTop = msgArea.scrollHeight;
          }
          if (json.error) {
            botBubble.innerHTML += `<br><span style="color:#f87171;">[错误]: ${json.error}</span>`;
          }
        } catch {}
      }
    }
  } catch (err) {
    botBubble.innerHTML = `<span style="color:#f87171;">对话请求失败: ${err.message}</span>`;
  }
}

// ---------------- 凭证与添加标的弹窗逻辑 ----------------
document.getElementById('setTokenBtn').addEventListener('click', showTokenModal);
document.getElementById('saveTokenBtn').addEventListener('click', () => {
  const val = document.getElementById('tokenInput').value.trim();
  if (!val) {
    alert('密钥不能为空');
    return;
  }
  AUTH_TOKEN = val;
  localStorage.setItem('stock_monitor_token', val);
  hideTokenModal();
  updateAuthUI();
  loadStocks();
});

document.getElementById('openAddStockModalBtn').addEventListener('click', () => {
  document.getElementById('addStockModal').classList.add('active');
});
document.getElementById('cancelAddStockBtn').addEventListener('click', () => {
  document.getElementById('addStockModal').classList.remove('active');
});
document.getElementById('confirmAddStockBtn').addEventListener('click', async () => {
  const code = document.getElementById('newStockCode').value.trim();
  const notes = document.getElementById('newStockNotes').value.trim();
  const tip = document.getElementById('addStockLoadingTip');
  const btn = document.getElementById('confirmAddStockBtn');

  if (!code || !/^\d{6}$/.test(code)) {
    alert('请输入合法的 6 位 A 股股票代码（如 600519、000001、300750）！');
    return;
  }

  tip.style.display = 'block';
  btn.disabled = true;

  try {
    const res = await apiFetch('/api/stocks', {
      method: 'POST',
      body: JSON.stringify({ code, notes }),
    });
    alert(res.message || '标的添加成功！');
    document.getElementById('addStockModal').classList.remove('active');
    document.getElementById('newStockCode').value = '';
    document.getElementById('newStockNotes').value = '';
    loadStocks();
  } catch (err) {
    alert(`添加失败: ${err.message}`);
  } finally {
    tip.style.display = 'none';
    btn.disabled = false;
  }
});

// ---------------- 页面初始化 ----------------
window.addEventListener('DOMContentLoaded', () => {
  updateAuthUI();
  initNavigation();
  if (AUTH_TOKEN) {
    loadStocks();
  } else {
    showTokenModal();
  }
});
