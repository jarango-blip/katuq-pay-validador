'use strict';
// Almacenamiento del prototipo: un archivo JSON. En Katuq se reemplaza por tablas PostgreSQL
// (devices, raw_signals, bank_templates, verified_payments, receipts) con comercio_id en cada una.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EMPTY = { merchants: [], linkCodes: [], devices: [], rawSignals: [], payments: [], orders: [], receipts: [], audit: [] };

class Store {
  constructor(file) {
    this.file = file;
    this.data = structuredClone(EMPTY);
    if (file && fs.existsSync(file)) {
      this.data = { ...structuredClone(EMPTY), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    }
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
  id(prefix) {
    return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
  }
  insert(table, row) {
    this.data[table].push(row);
    this.save();
    return row;
  }
  update(table, id, patch) {
    const row = this.data[table].find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, patch);
    this.save();
    return row;
  }
  find(table, pred) {
    return this.data[table].find(pred) || null;
  }
  filter(table, pred) {
    return this.data[table].filter(pred);
  }
  audit(merchantId, action, detail) {
    this.data.audit.push({ at: new Date().toISOString(), merchantId, action, detail });
    this.save();
  }
}

module.exports = { Store };
