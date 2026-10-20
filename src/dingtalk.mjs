// 钉钉推送模块：自定义机器人 Webhook（支持加签）
// 用法：在钉钉群「群设置 → 机器人 → 添加机器人 → 自定义」拿到 webhook 地址，
//       安全设置建议选「加签」，把 secret 填到 config.json。
import crypto from 'node:crypto';

// 钉钉加签：HMAC-SHA256(base64) + urlencode
export function dingtalkSign(secret, timestamp) {
  const stringToSign = `${timestamp}\n${secret}`;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(stringToSign);
  return encodeURIComponent(hmac.digest('base64'));
}

/**
 * 发送 markdown 消息到钉钉机器人。
 * @returns {Promise<{ok:boolean, errcode:number, errmsg:string}>}
 */
export async function sendDingtalk(webhook, secret, text, title) {
  let url = webhook;
  if (secret) {
    const timestamp = Date.now();
    const sign = dingtalkSign(secret, timestamp);
    url += `${webhook.includes('?') ? '&' : '?'}timestamp=${timestamp}&sign=${sign}`;
  }
  const body = {
    msgtype: 'markdown',
    markdown: { title: title || 'A股监控', text },
  };
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, errcode: -1, errmsg: `网络错误: ${e.message}` };
  }
  let json = {};
  try {
    json = await res.json();
  } catch {
    return { ok: false, errcode: res.status, errmsg: `响应非JSON: ${res.status}` };
  }
  return { ok: json.errcode === 0, errcode: json.errcode, errmsg: json.errmsg || '' };
}

// 把监控结果转成钉钉 markdown 文本
export function formatDingtalkMarkdown(result) {
  const levelTag = result.overall_level;
  const lines = [];
  lines.push(`### 【${levelTag}】${result.stock}`);
  for (const e of result.events || []) {
    lines.push(`- **[${e.level}] ${e.category}** ${e.time}  ${e.summary}`);
  }
  if (result.pending_data && result.pending_data.length) {
    lines.push(`- 待披露：${result.pending_data.join('；')}`);
  }
  if (result.data_source_issues && result.data_source_issues.length) {
    lines.push(`- 数据源异常：${result.data_source_issues.join('；')}`);
  }
  lines.push(`> ${result.check_time} ｜ 仅为信息整理，不构成投资建议`);
  return lines.join('\n');
}

// 判断是否应推送（无新增永不推送；pushLevel 决定最低推送级别）
const LEVEL_RANK = { 绿: 0, 黄: 1, 红: 2 };
export function shouldPush(result, pushLevel = '黄') {
  const lvl = result.overall_level;
  if (lvl === '无新增') return false;
  return (LEVEL_RANK[lvl] ?? 0) >= (LEVEL_RANK[pushLevel] ?? 1);
}
