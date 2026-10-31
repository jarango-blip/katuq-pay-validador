'use strict';
// Prototipo del validador de pagos de Katuq Pay.
// Diseño propio: recibe avisos del banco (app Android o correo reenviado), los interpreta y los cruza con pedidos.

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Store } = require('./store');
const { loadTemplates, compileTemplates, saveTemplates, parseSignal, DEFAULT_FILE } = require('./parser');
const { matchPayment, matchReceipt } = require('./matcher');
const webhook = require('./webhook');

const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const HEARTBEAT_STALE_MS = 15 * 60 * 1000;
const randomToken = (prefix) => `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
const randomCode = () => Array.from(crypto.randomBytes(8), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[b % 24]).join('');

function createApp({ dataFile = null, templatesFile = DEFAULT_FILE, deliverWebhook = webhook.deliver, matchOptions = {}, adminKey = process.env.ADMIN_KEY } = {}) {
  const store = new Store(dataFile);
  let templates = loadTemplates(templatesFile);
  const streams = new Map(); // merchantId -> Set(res)
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---------- auth ----------
  const merchantAuth = (req, res, next) => {
    const key = (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.query.key;
    const m = key && store.find('merchants', (x) => x.apiKey === key);
    if (!m) return res.status(401).json({ error: 'llave de comercio inválida' });
    req.merchant = m;
    next();
  };
  const deviceAuth = (req, res, next) => {
    const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const d = token && store.find('devices', (x) => x.token === token && !x.revoked);
    if (!d) return res.status(401).json({ error: 'dispositivo no vinculado' });
    req.device = d;
    req.merchant = store.find('merchants', (x) => x.id === d.merchantId);
    next();
  };

  // ---------- eventos ----------
  function emit(merchant, type, data) {
    const event = { type, createdAt: new Date().toISOString(), data };
    for (const res of streams.get(merchant.id) || []) res.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (merchant.webhookUrl && type === 'payment.verified') {
      Promise.resolve(deliverWebhook(merchant.webhookUrl, merchant.webhookSecret, event)).catch(() => {});
    }
  }

  // ---------- núcleo ----------
  function processSignal(merchant, signal) {
    const minute = (signal.occurredAt || signal.receivedAt).slice(0, 16);
    const hash = crypto.createHash('sha256').update(`${signal.source}|${signal.package || signal.from}|${signal.title}|${signal.text}|${minute}`).digest('hex');
    const dup = store.find('rawSignals', (r) => r.merchantId === merchant.id && r.hash === hash);
    if (dup) return { duplicate: true, rawSignalId: dup.id, paymentId: dup.paymentId || null };

    const parsed = parseSignal(templates, signal);
    const raw = store.insert('rawSignals', { id: store.id('sig'), merchantId: merchant.id, hash, ...signal, parse: parsed });
    if (parsed.status !== 'parsed') return { rawSignalId: raw.id, parse: parsed };

    const payment = store.insert('payments', {
      id: store.id('pay'),
      merchantId: merchant.id,
      bank: parsed.bank,
      amount: parsed.amount,
      payer: parsed.payer,
      reference: parsed.reference,
      occurredAt: signal.occurredAt || signal.receivedAt,
      rawSignalId: raw.id,
      source: signal.source,
      status: 'verificado',
      orderId: null,
    });
    raw.paymentId = payment.id;
    store.save();
    applyMatch(merchant, payment);
    emit(merchant, 'payment.verified', payment);
    return { rawSignalId: raw.id, parse: parsed, payment };
  }

  function applyMatch(merchant, payment) {
    // Primero: ¿hay un comprobante esperando este aviso?
    const waiting = store.filter('receipts', (r) => r.merchantId === merchant.id && r.result === 'no_signal');
    for (const r of waiting) {
      const m = matchReceipt(r, [payment], matchOptions);
      if (m.result === 'confirmed') {
        store.update('receipts', r.id, { result: 'confirmed', paymentId: payment.id });
        return assign(merchant, payment, r.orderId, 'comprobante');
      }
    }
    const orders = store.filter('orders', (o) => o.merchantId === merchant.id);
    const m = matchPayment(payment, orders, matchOptions);
    if (m.result === 'assigned') return assign(merchant, payment, m.orderId, m.rule);
    store.update('payments', payment.id, { status: 'en_revision', reviewReason: m.reason, candidates: m.candidates || [] });
    for (const oid of m.candidates || []) store.update('orders', oid, { status: 'pago_en_revision' });
  }

  function assign(merchant, payment, orderId, rule, actor = 'sistema') {
    store.update('payments', payment.id, { status: 'asignado', orderId, rule, reviewReason: null, candidates: [] });
    store.update('orders', orderId, { status: 'pagado', paymentId: payment.id, paidAt: payment.occurredAt });
    store.audit(merchant.id, 'asignar_pago', { paymentId: payment.id, orderId, rule, actor });
    emit(merchant, 'order.paid', { orderId, paymentId: payment.id, rule });
  }

  // ---------- rutas ----------
  // Alta de comercio (en Katuq lo hace el panel; aquí para probar)
  app.post('/v1/merchants', (req, res) => {
    const m = store.insert('merchants', {
      id: store.id('com'),
      name: req.body.name || 'Comercio de prueba',
      apiKey: randomToken('mk'),
      webhookUrl: req.body.webhookUrl || null,
      webhookSecret: randomToken('whsec'),
      createdAt: new Date().toISOString(),
    });
    res.status(201).json(m);
  });

  app.post('/v1/devices/link-code', merchantAuth, (req, res) => {
    const code = randomCode();
    store.insert('linkCodes', { code, merchantId: req.merchant.id, expiresAt: Date.now() + LINK_CODE_TTL_MS, used: false });
    res.status(201).json({ code, expiresInSeconds: LINK_CODE_TTL_MS / 1000 });
  });

  app.post('/v1/devices/link', (req, res) => {
    const code = String(req.body.code || '').toUpperCase().trim();
    const lc = store.find('linkCodes', (c) => c.code === code);
    if (!lc || lc.used || lc.expiresAt < Date.now()) return res.status(400).json({ error: 'código inválido o vencido' });
    lc.used = true;
    const d = store.insert('devices', {
      id: store.id('dev'),
      merchantId: lc.merchantId,
      name: req.body.name || 'Caja',
      token: randomToken('dt'),
      appVersion: req.body.appVersion || null,
      lastHeartbeat: new Date().toISOString(),
      revoked: false,
    });
    res.status(201).json({ deviceId: d.id, token: d.token });
  });

  app.post('/v1/devices/heartbeat', deviceAuth, (req, res) => {
    store.update('devices', req.device.id, {
      lastHeartbeat: new Date().toISOString(),
      listenerEnabled: req.body.listenerEnabled ?? null,
      appVersion: req.body.appVersion ?? req.device.appVersion,
    });
    res.json({ ok: true });
  });

  app.get('/v1/devices', merchantAuth, (req, res) => {
    const now = Date.now();
    res.json(
      store.filter('devices', (d) => d.merchantId === req.merchant.id).map(({ token, ...d }) => ({
        ...d,
        listening: !d.revoked && now - new Date(d.lastHeartbeat) < HEARTBEAT_STALE_MS,
      }))
    );
  });

  app.post('/v1/signals/notification', deviceAuth, (req, res) => {
    const { package: pkg, title = '', text = '', postedAt } = req.body;
    if (!pkg || !text) return res.status(400).json({ error: 'package y text son obligatorios' });
    const out = processSignal(req.merchant, {
      source: 'notification',
      package: pkg,
      title: String(title).slice(0, 500),
      text: String(text).slice(0, 2000),
      deviceId: req.device.id,
      occurredAt: postedAt ? new Date(postedAt).toISOString() : new Date().toISOString(),
      receivedAt: new Date().toISOString(),
    });
    res.status(out.duplicate ? 200 : 201).json(out);
  });

  // En producción lo llama el receptor de correo entrante (dirección única por comercio).
  app.post('/v1/signals/email', merchantAuth, (req, res) => {
    const { from, subject = '', text = '', receivedAt } = req.body;
    if (!from || !text) return res.status(400).json({ error: 'from y text son obligatorios' });
    const out = processSignal(req.merchant, {
      source: 'email',
      from: String(from).toLowerCase(),
      title: String(subject).slice(0, 500),
      text: String(text).slice(0, 5000),
      occurredAt: receivedAt ? new Date(receivedAt).toISOString() : new Date().toISOString(),
      receivedAt: new Date().toISOString(),
    });
    res.status(out.duplicate ? 200 : 201).json(out);
  });

  // Pedidos pendientes: en Katuq vienen del OMS; aquí se crean para simular.
  app.post('/v1/orders', merchantAuth, (req, res) => {
    const amount = Math.round(Number(req.body.amount));
    if (!amount || amount <= 0) return res.status(400).json({ error: 'monto inválido' });
    const o = store.insert('orders', {
      id: store.id('ped'),
      merchantId: req.merchant.id,
      amount,
      reference: req.body.reference || `KP-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      description: req.body.description || null,
      status: 'pendiente',
      createdAt: req.body.createdAt ? new Date(req.body.createdAt).toISOString() : new Date().toISOString(),
    });
    res.status(201).json(o);
  });

  app.get('/v1/orders', merchantAuth, (req, res) => res.json(store.filter('orders', (o) => o.merchantId === req.merchant.id)));

  app.get('/v1/payments', merchantAuth, (req, res) => {
    const { status } = req.query;
    res.json(store.filter('payments', (p) => p.merchantId === req.merchant.id && (!status || p.status === status)));
  });

  app.get('/v1/signals/unparsed', merchantAuth, (req, res) =>
    res.json(store.filter('rawSignals', (r) => r.merchantId === req.merchant.id && r.parse.status === 'unparsed'))
  );

  app.post('/v1/payments/:id/assign', merchantAuth, (req, res) => {
    const { orderId, user, reason } = req.body;
    if (!user || !reason) return res.status(400).json({ error: 'user y reason son obligatorios' });
    const p = store.find('payments', (x) => x.id === req.params.id && x.merchantId === req.merchant.id);
    const o = store.find('orders', (x) => x.id === orderId && x.merchantId === req.merchant.id);
    if (!p || !o) return res.status(404).json({ error: 'pago o pedido no encontrado' });
    if (p.status === 'asignado') return res.status(409).json({ error: 'el pago ya está asignado; un aviso se usa una sola vez' });
    store.audit(req.merchant.id, 'asignacion_manual', { paymentId: p.id, orderId, user, reason });
    assign(req.merchant, p, orderId, 'manual', user);
    res.json(store.find('payments', (x) => x.id === p.id));
  });

  // Comprobante (pantallazo): solo ayuda a cruzar, nunca confirma por sí solo.
  app.post('/v1/receipts', merchantAuth, (req, res) => {
    const { orderId, amount, occurredAt } = req.body;
    const o = store.find('orders', (x) => x.id === orderId && x.merchantId === req.merchant.id);
    if (!o) return res.status(404).json({ error: 'pedido no encontrado' });
    const receipt = {
      id: store.id('cmp'),
      merchantId: req.merchant.id,
      orderId,
      amount: Math.round(Number(amount)),
      occurredAt: occurredAt ? new Date(occurredAt).toISOString() : new Date().toISOString(),
    };
    const payments = store.filter('payments', (p) => p.merchantId === req.merchant.id);
    const m = matchReceipt(receipt, payments, matchOptions);
    receipt.result = m.result;
    if (m.result === 'confirmed') {
      receipt.paymentId = m.paymentId;
      store.insert('receipts', receipt);
      assign(req.merchant, store.find('payments', (p) => p.id === m.paymentId), orderId, 'comprobante');
    } else {
      store.insert('receipts', receipt);
      store.update('orders', orderId, { status: 'pago_en_revision' });
      if (receipt.amount !== o.amount) receipt.alert = 'el monto del comprobante no coincide con el pedido';
      emit(req.merchant, 'receipt.unverified', receipt);
    }
    res.status(201).json(receipt);
  });

  // Modo caja: eventos en vivo (Server-Sent Events)
  app.get('/v1/stream', merchantAuth, (req, res) => {
    res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.flushHeaders();
    res.write(`event: hello\ndata: {"merchant":"${req.merchant.name.replace(/"/g, '')}"}\n\n`);
    if (!streams.has(req.merchant.id)) streams.set(req.merchant.id, new Set());
    streams.get(req.merchant.id).add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      streams.get(req.merchant.id).delete(res);
    });
  });

  // ---------- laboratorio / calibración ----------
  app.get('/v1/signals', merchantAuth, (req, res) =>
    res.json(store.filter('rawSignals', (r) => r.merchantId === req.merchant.id).slice(-200).reverse())
  );
  app.get('/v1/receipts', merchantAuth, (req, res) =>
    res.json(store.filter('receipts', (r) => r.merchantId === req.merchant.id).reverse())
  );
  app.get('/v1/templates', (_req, res) => res.json(templates.map(({ re, ...t }) => t)));

  // Prueba un texto contra las plantillas actuales o contra una plantilla candidata (sin guardar)
  app.post('/v1/templates/try', (req, res) => {
    const { signal, template } = req.body || {};
    if (!signal || !signal.text) return res.status(400).json({ error: 'signal.text es obligatorio' });
    try {
      const list = template ? compileTemplates([template]) : templates;
      res.json(parseSignal(list, { source: 'notification', ...signal }));
    } catch (e) {
      res.status(400).json({ error: `expresión inválida: ${e.message}` });
    }
  });

  // Simula un aviso como si llegara de la app (solo para el laboratorio; desactivar en producción)
  app.post('/v1/lab/notification', merchantAuth, (req, res) => {
    if (process.env.LAB_DISABLED === '1') return res.status(404).end();
    const { package: pkg, title = '', text = '', postedAt } = req.body;
    if (!pkg || !text) return res.status(400).json({ error: 'package y text son obligatorios' });
    const out = processSignal(req.merchant, {
      source: 'notification', package: pkg, title, text, deviceId: 'laboratorio', simulated: true,
      occurredAt: postedAt ? new Date(postedAt).toISOString() : new Date().toISOString(),
      receivedAt: new Date().toISOString(),
    });
    res.status(out.duplicate ? 200 : 201).json(out);
  });

  // Guarda plantillas (requiere ADMIN_KEY). Reprocesa los avisos no interpretados.
  app.put('/v1/templates', (req, res) => {
    const key = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!adminKey || key !== adminKey) return res.status(401).json({ error: 'llave de administrador inválida' });
    try {
      saveTemplates(req.body.templates, templatesFile);
      templates = loadTemplates(templatesFile);
    } catch (e) {
      return res.status(400).json({ error: `no se guardó: ${e.message}` });
    }
    let recovered = 0;
    for (const raw of store.filter('rawSignals', (r) => r.parse.status === 'unparsed')) {
      const parsed = parseSignal(templates, raw);
      if (parsed.status !== 'parsed') continue;
      const merchant = store.find('merchants', (m) => m.id === raw.merchantId);
      store.update('rawSignals', raw.id, { parse: parsed });
      const payment = store.insert('payments', {
        id: store.id('pay'), merchantId: merchant.id, bank: parsed.bank, amount: parsed.amount, payer: parsed.payer,
        reference: parsed.reference, occurredAt: raw.occurredAt, rawSignalId: raw.id, source: raw.source, status: 'verificado', orderId: null,
      });
      store.update('rawSignals', raw.id, { paymentId: payment.id });
      applyMatch(merchant, payment);
      emit(merchant, 'payment.verified', payment);
      recovered++;
    }
    res.json({ ok: true, templates: templates.length, recovered });
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.locals.store = store;
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  const app = createApp({ dataFile: process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json') });
  app.listen(port, () => console.log(`Validador Katuq Pay escuchando en http://localhost:${port}`));
}

module.exports = { createApp };
