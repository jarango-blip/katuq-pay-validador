'use strict';
// Webhook firmado: X-KatuqPay-Signature = t=<unix>,v1=<hex HMAC-SHA256 de "<t>.<body>">

const crypto = require('crypto');

function sign(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

function verify(secret, body, header, toleranceSec = 300) {
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = sign(secret, body, t).split('v1=')[1];
  const given = parts.v1 || '';
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

async function deliver(url, secret, event, { attempts = 4, baseDelayMs = 1000, fetchImpl = fetch } = {}) {
  const body = JSON.stringify(event);
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-KatuqPay-Signature': sign(secret, body) },
        body,
      });
      if (res.ok) return { ok: true, attempts: i + 1 };
    } catch (_) {
      /* reintenta */
    }
    await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
  }
  return { ok: false, attempts };
}

module.exports = { sign, verify, deliver };
