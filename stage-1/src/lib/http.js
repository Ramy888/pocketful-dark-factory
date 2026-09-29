'use strict';

const { AppError } = require('./errors');

// Content-Length is set explicitly on every response. Node only infers
// framing (chunked Transfer-Encoding) when a body is written; on a bodyless
// response (HEAD, 204) it infers nothing, which leaves a keep-alive
// connection unframed and the client waiting for a close that never comes.
//
// HEAD gets Content-Length: 0, not the GET-equivalent length: Node never
// writes body bytes for a HEAD response, and a client that takes a nonzero
// Content-Length literally (curl's `-X HEAD`, unlike its `-I`/`--head`,
// does not know to stop after headers) would otherwise hang or error
// waiting for bytes that were never coming.
function sendJson(res, status, payload) {
  const isHead = res.req && res.req.method === 'HEAD';
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': isHead ? 0 : body.length,
  });
  res.end(isHead ? undefined : body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function sendNoContent(res, status) {
  res.writeHead(status || 204, { 'Content-Length': 0 });
  res.end();
}

// Reads the raw request body and parses it per D11/D12: parsed regardless of
// Content-Type, an absent/empty body is {}, and anything that parses to a
// non-object JSON value (array, string, number, boolean, null) is malformed
// in the same way unparseable JSON is.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') {
        resolve({});
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        reject(new AppError(400, 'malformed_request', 'request body is not valid JSON'));
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        reject(new AppError(400, 'malformed_request', 'request body must be a JSON object'));
        return;
      }
      resolve(parsed);
    });
    req.on('error', () => {
      reject(new AppError(400, 'malformed_request', 'error reading request body'));
    });
  });
}

module.exports = { sendJson, sendError, sendNoContent, readJsonBody };
