// HTTP 封装：统一 User-Agent、超时、重试与错误处理
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 发起 GET 请求，返回文本。失败重试 retries 次。
 */
export async function httpGet(url, opts = {}) {
  const { headers = {}, retries = 2, timeout = 15000 } = opts;
  const hdrs = { 'User-Agent': DEFAULT_UA, ...headers };
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      const res = await fetch(url, { headers: hdrs, signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(500 * (i + 1));
    }
  }
  throw lastErr;
}

/**
 * 发起 POST 请求（application/x-www-form-urlencoded），返回文本。
 */
export async function httpPost(url, body, opts = {}) {
  const { headers = {}, retries = 2, timeout = 15000 } = opts;
  const hdrs = {
    'User-Agent': DEFAULT_UA,
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    ...headers,
  };
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      const res = await fetch(url, {
        method: 'POST',
        headers: hdrs,
        body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(500 * (i + 1));
    }
  }
  throw lastErr;
}

export { sleep };
