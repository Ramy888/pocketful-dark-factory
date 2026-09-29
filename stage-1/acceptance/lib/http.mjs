// Raw HTTP client for the Pocketful stage-1 acceptance suite.
//
// Deliberately uses node:http rather than fetch so the suite can send bodies that
// are not valid JSON, omit Content-Type, send empty bodies, and observe exact
// response bytes -- all of which the specification makes observable behaviour.
// Zero third-party dependencies: the suite must run anywhere Node 18+ runs.

import http from 'node:http';
import https from 'node:https';

const agents = new Map();

function agentFor(url) {
  const key = url.protocol;
  if (!agents.has(key)) {
    const Agent = url.protocol === 'https:' ? https.Agent : http.Agent;
    // 64 sockets: the specification allows up to 50 concurrent in-flight requests
    // (spec section 2, resource limits) and the concurrency checks go near that.
    agents.set(key, new Agent({ keepAlive: true, maxSockets: 64 }));
  }
  return agents.get(key);
}

export function shellQuote(value) {
  return "'" + String(value).replace(/'/g, `'\\''`) + "'";
}

// A copy-pasteable reproduction command for one exchange.
export function curlFor({ base, method, path, headers, body, curlBody }) {
  const parts = ['curl -sS -i'];
  if (method && method !== 'GET') parts.push('-X ' + method);
  parts.push(shellQuote(base + path));
  for (const [name, value] of Object.entries(headers || {})) {
    parts.push('-H ' + shellQuote(`${name}: ${value}`));
  }
  if (curlBody !== undefined) parts.push(curlBody);
  else if (body !== undefined && body !== null) parts.push('--data-binary ' + shellQuote(body));
  return parts.join(' ');
}

export function request(options) {
  const {
    base,
    method = 'GET',
    path = '/',
    headers = {},
    body,
    timeoutMs = 20000,
    curlBody,
  } = options;

  const url = new URL(base + path);
  const outHeaders = { ...headers };
  let payload;
  if (body !== undefined && body !== null) {
    payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    if (!hasHeader(outHeaders, 'content-length')) outHeaders['Content-Length'] = String(payload.length);
  }

  const curl = curlFor({ base, method, path, headers, body: payload ? payload.toString('utf8') : undefined, curlBody });
  const started = Date.now();

  return new Promise((resolve) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: outHeaders,
        agent: agentFor(url),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const text = raw.toString('utf8');
          let json;
          let jsonError = null;
          if (text.length > 0) {
            try {
              json = JSON.parse(text);
            } catch (err) {
              jsonError = err.message;
            }
          }
          resolve({
            base, method, path, requestHeaders: outHeaders,
            requestBody: payload ? payload.toString('utf8') : undefined,
            status: res.statusCode,
            headers: res.headers,
            raw, text, json, jsonError,
            ms: Date.now() - started,
            curl,
          });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`client timeout after ${timeoutMs} ms`));
    });
    req.on('error', (err) => {
      resolve({
        base, method, path, requestHeaders: outHeaders,
        requestBody: payload ? payload.toString('utf8') : undefined,
        status: 0,
        headers: {},
        raw: Buffer.alloc(0), text: '', json: undefined, jsonError: null,
        networkError: err.message,
        ms: Date.now() - started,
        curl,
      });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function hasHeader(headers, name) {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

export async function waitForHealth(base, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let last = null;
  for (;;) {
    last = await request({ base, path: '/health', timeoutMs: 5000 });
    if (last.status === 200) return { ok: true, res: last, waitedMs: budgetMs - (deadline - Date.now()) };
    if (Date.now() >= deadline) return { ok: false, res: last };
    await new Promise((r) => setTimeout(r, 250));
  }
}
