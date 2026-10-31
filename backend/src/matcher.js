'use strict';
// Reglas de cruce entre pagos verificados y pedidos pendientes.
// Regla de oro: solo un aviso del banco marca un pedido como pagado. Si hay duda, va a revisión.

const DEFAULTS = {
  windowMinutes: 120, // ventana para cruzar por monto
  receiptToleranceMinutes: 10, // ± minutos entre comprobante y aviso
};

const minutes = (a, b) => Math.abs(new Date(a) - new Date(b)) / 60000;

/**
 * Intenta asignar un pago a un pedido pendiente.
 * @returns {{result:'assigned', orderId, rule} | {result:'review', reason, candidates?}}
 */
function matchPayment(payment, pendingOrders, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const open = pendingOrders.filter((o) => o.status === 'pendiente' || o.status === 'pago_en_revision');

  // 1. Referencia exacta
  if (payment.reference) {
    const byRef = open.find((o) => o.reference && o.reference.toUpperCase() === payment.reference);
    if (byRef) {
      if (byRef.amount !== payment.amount) {
        return { result: 'review', reason: 'referencia coincide pero el monto no', candidates: [byRef.id] };
      }
      return { result: 'assigned', orderId: byRef.id, rule: 'referencia' };
    }
  }

  // 2. Monto exacto dentro de la ventana, y único
  const sameAmount = open.filter(
    (o) =>
      o.amount === payment.amount &&
      new Date(o.createdAt) <= new Date(payment.occurredAt) &&
      minutes(o.createdAt, payment.occurredAt) <= cfg.windowMinutes
  );
  if (sameAmount.length === 1) {
    return { result: 'assigned', orderId: sameAmount[0].id, rule: 'monto_unico' };
  }
  if (sameAmount.length > 1) {
    return { result: 'review', reason: 'varios pedidos con el mismo monto', candidates: sameAmount.map((o) => o.id) };
  }
  return { result: 'review', reason: 'pago sin pedido que coincida' };
}

/**
 * Cruza un comprobante (pantallazo) contra los avisos verificados.
 * Un comprobante NUNCA confirma por sí solo.
 * @returns {{result:'confirmed', paymentId} | {result:'no_signal'} | {result:'ambiguous', candidates}}
 */
function matchReceipt(receipt, payments, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const free = payments.filter(
    (p) =>
      (p.status === 'verificado' || p.status === 'en_revision') &&
      p.amount === receipt.amount &&
      minutes(p.occurredAt, receipt.occurredAt) <= cfg.receiptToleranceMinutes
  );
  if (free.length === 1) return { result: 'confirmed', paymentId: free[0].id };
  if (free.length > 1) return { result: 'ambiguous', candidates: free.map((p) => p.id) };
  return { result: 'no_signal' };
}

module.exports = { matchPayment, matchReceipt, DEFAULTS };
