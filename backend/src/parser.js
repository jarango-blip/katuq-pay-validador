'use strict';
// Interpreta un aviso crudo (notificación o correo) con la plantilla de su banco.
// La lógica es genérica; lo específico de cada banco vive en templates/banks.json.

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'templates', 'banks.json');

function loadTemplates(file = DEFAULT_FILE) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return compileTemplates(raw.templates);
}

// Lanza error si alguna expresión no compila: así una plantilla mala nunca se guarda.
function compileTemplates(list) {
  return list.map((t) => ({
    ...t,
    re: {
      credit: new RegExp(t.credit, 'i'),
      ignore: t.ignore ? new RegExp(t.ignore, 'i') : null,
      amount: new RegExp(t.amount, 'i'),
      payer: t.payer ? new RegExp(t.payer, 'i') : null,
      reference: t.reference ? new RegExp(t.reference, 'i') : null,
    },
  }));
}

// "$50.000" | "$ 50.000,00" | "$50,000.00" | "$1.250.000" -> pesos enteros
function parseAmountCOP(str) {
  if (!str) return null;
  let s = String(str).trim().replace(/[^\d.,]/g, '');
  if (!s) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  const lastSep = Math.max(lastDot, lastComma);
  // Si el último separador deja 1 o 2 dígitos al final, son decimales.
  if (lastSep >= 0 && s.length - lastSep - 1 <= 2 && s.length - lastSep - 1 > 0) {
    const intPart = s.slice(0, lastSep).replace(/[.,]/g, '');
    const dec = s.slice(lastSep + 1).padEnd(2, '0');
    const value = Number(intPart || '0') + Number(dec) / 100;
    return Math.round(value);
  }
  const n = Number(s.replace(/[.,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function selectTemplates(templates, signal) {
  return templates.filter((t) => {
    if (t.source !== signal.source) return false;
    if (signal.source === 'notification') {
      return (t.match.packages || []).includes(signal.package);
    }
    if (signal.source === 'email') {
      const from = String(signal.from || '').toLowerCase();
      return (t.match.senders || []).some((d) => from.endsWith(d.toLowerCase()));
    }
    return false;
  });
}

/**
 * @returns {{status:'parsed'|'ignored'|'unparsed', bank?, amount?, payer?, reference?, templateVersion?, reason?}}
 */
function parseSignal(templates, signal) {
  const candidates = selectTemplates(templates, signal);
  if (!candidates.length) return { status: 'ignored', reason: 'fuente o banco no soportado' };

  const text = [signal.title, signal.text].filter(Boolean).join(' · ').replace(/\s+/g, ' ').trim();

  for (const t of candidates) {
    if (t.re.ignore && t.re.ignore.test(text) && !t.re.credit.test(text)) {
      return { status: 'ignored', bank: t.bank, reason: 'no es un abono' };
    }
    if (!t.re.credit.test(text)) continue;
    const m = text.match(t.re.amount);
    const amount = m ? parseAmountCOP(m[1]) : null;
    if (!amount || amount <= 0) continue;
    const payerMatch = t.re.payer ? text.match(t.re.payer) : null;
    const refMatch = t.re.reference ? text.match(t.re.reference) : null;
    return {
      status: 'parsed',
      bank: t.bank,
      amount,
      payer: payerMatch ? payerMatch[1].trim() : null,
      reference: refMatch ? refMatch[1].toUpperCase() : null,
      templateVersion: t.version,
    };
  }
  return { status: 'unparsed', bank: candidates[0].bank, reason: 'ninguna plantilla reconoció el texto' };
}

function saveTemplates(list, file = DEFAULT_FILE) {
  compileTemplates(list); // valida antes de escribir
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.templates = list.map(({ re, ...t }) => ({ ...t, version: (t.version || 0) + 1 }));
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  return raw.templates;
}

module.exports = { loadTemplates, compileTemplates, saveTemplates, parseAmountCOP, parseSignal, DEFAULT_FILE };
