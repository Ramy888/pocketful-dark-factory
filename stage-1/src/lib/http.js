'use strict';

const { AppError } = require('./errors');

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function sendNoContent(res, status) {
  res.writeHead(status || 204);
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
