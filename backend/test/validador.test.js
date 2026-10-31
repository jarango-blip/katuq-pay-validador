'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { loadTemplates, parseAmountCOP, parseSignal } = require('../src/parser');
const { matchPayment } = require('../src/matcher');
const webhook = require('../src/webhook');

// Los textos de aviso de estas pruebas son ilustrativos: se reemplazan por avisos reales al calibrar.
const NEQUI = 'com.nequi.MobileApp';
const DAVI = 'com.davivienda.daviplataapp';

test('parseAmountCOP entiende formatos colombianos', () => {
  assert.strictEqual(parseAmountCOP('50.000'), 50000);
  assert.strictEqual(parseAmountCOP('50.000,00'), 50000);
  assert.strictEqual(parseAmountCOP('1.250.000'), 1250000);
  assert.strictEqual(parseAmountCOP('50,000.00'), 50000);
  assert.strictEqual(parseAmountCOP('2000'), 2000);
  assert.strictEqual(parseAmountCOP(''), null);
});

test('parser: abono reconocido, egreso ignorado, banco no soportado', () => {
  const t = loadTemplates();
  const ok = parseSignal(t, { source: 'notification', package: NEQUI, title: 'Nequi', text: 'Recibiste $50.000 de Ana Pérez' });
  assert.strictEqual(ok.status, 'parsed');
  assert.strictEqual(ok.amount, 50000);
  assert.strictEqual(ok.payer, 'Ana Pérez');
  const out = parseSignal(t, { source: 'notification', package: NEQUI, title: 'Nequi', text: 'Enviaste $20.000 a Pedro' });
  assert.strictEqual(out.status, 'ignored');
  const other = parseSignal(t, { source: 'notification', package: 'com.whatsapp', title: 'x', text: 'Recibiste $1.000' });
  assert.strictEqual(other.status, 'ignored');
  const ref = parseSignal(t, { source: 'notification', package: DAVI, title: 'DaviPlata', text: 'Te llegó un abono por $35.500,00 de Luis. Mensaje: KP-AB12CD' });
  assert.strictEqual(ref.status, 'parsed');
  assert.strictEqual(ref.amount, 35500);
  assert.strictEqual(ref.reference, 'KP-AB12CD');
});

test('matcher: monto repetido va a revisión', () => {
  const now = new Date().toISOString();
  const orders = [
    { id: 'a', amount: 10000, status: 'pendiente', createdAt: now },
    { id: 'b', amount: 10000, status: 'pendiente', createdAt: now },
  ];
  const r = matchPayment({ amount: 10000, occurredAt: new Date(Date.now() + 1000).toISOString() }, orders);
  assert.strictEqual(r.result, 'review');
  assert.deepStrictEqual(r.candidates.sort(), ['a', 'b']);
});

test('webhook: firma verificable', () => {
  const body = JSON.stringify({ hola: 1 });
  const h = webhook.sign('secreto', body);
  assert.ok(webhook.verify('secreto', body, h));
  assert.ok(!webhook.verify('otro', body, h));
});

test('flujo completo por HTTP', async () => {
  const sent = [];
  const app = createApp({ deliverWebhook: async (url, secret, ev) => { sent.push(ev); return { ok: true }; } });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    const m = (await call('POST', '/v1/merchants', { name: 'Almara', webhookUrl: 'https://example.test/hook' })).body;
    const code = (await call('POST', '/v1/devices/link-code', {}, m.apiKey)).body.code;
    const dev = (await call('POST', '/v1/devices/link', { code, name: 'Caja 1' })).body;
    assert.ok(dev.token);
    // el código no se reutiliza
    assert.strictEqual((await call('POST', '/v1/devices/link', { code })).status, 400);

    const order = (await call('POST', '/v1/orders', { amount: 50000 }, m.apiKey)).body;
    const n1 = await call('POST', '/v1/signals/notification', { package: NEQUI, title: 'Nequi', text: 'Recibiste $50.000 de Ana Pérez' }, dev.token);
    assert.strictEqual(n1.status, 201);
    assert.strictEqual(n1.body.payment.amount, 50000);

    // duplicado del mismo aviso: no crea otro pago
    const n2 = await call('POST', '/v1/signals/notification', { package: NEQUI, title: 'Nequi', text: 'Recibiste $50.000 de Ana Pérez' }, dev.token);
    assert.strictEqual(n2.body.duplicate, true);

    const orders = (await call('GET', '/v1/orders', null, m.apiKey)).body;
    assert.strictEqual(orders.find((o) => o.id === order.id).status, 'pagado');
    assert.strictEqual(sent.length, 1);

    // comprobante falso: no hay aviso -> pago en revisión, nunca pagado
    const order2 = (await call('POST', '/v1/orders', { amount: 80000 }, m.apiKey)).body;
    const rc = (await call('POST', '/v1/receipts', { orderId: order2.id, amount: 80000 }, m.apiKey)).body;
    assert.strictEqual(rc.result, 'no_signal');
    let o2 = (await call('GET', '/v1/orders', null, m.apiKey)).body.find((o) => o.id === order2.id);
    assert.strictEqual(o2.status, 'pago_en_revision');

    // llega el aviso real después: el comprobante queda confirmado y el pedido pagado
    await call('POST', '/v1/signals/notification', { package: DAVI, title: 'DaviPlata', text: 'Recibiste $80.000 de Luis Gómez' }, dev.token);
    o2 = (await call('GET', '/v1/orders', null, m.apiKey)).body.find((o) => o.id === order2.id);
    assert.strictEqual(o2.status, 'pagado');

    // aviso no interpretable queda guardado para calibrar
    await call('POST', '/v1/signals/notification', { package: NEQUI, title: 'Nequi', text: 'Movimiento en tu cuenta' }, dev.token);
    const unparsed = (await call('GET', '/v1/signals/unparsed', null, m.apiKey)).body;
    assert.strictEqual(unparsed.length, 1);

    const devices = (await call('GET', '/v1/devices', null, m.apiKey)).body;
    assert.strictEqual(devices[0].listening, true);
    assert.ok(!('token' in devices[0]));
  } finally {
    server.close();
  }
});
