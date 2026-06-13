// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Tiny GATT helper shared by examples: add a service to our emulated peripheral's server unless an
// equal-UUID service is already there, then rebuild the live attribute DB. Keeps examples honest —
// the script's bt.notify()/bt.onWrite() target characteristics that actually exist.

const sameUuid = (a, b) => String(a).replace(/^0x/i, '').toUpperCase() === String(b).replace(/^0x/i, '').toUpperCase();

export function ensureService(store, conn, svc) {
  if ((store.state.gatt.services || []).some((s) => sameUuid(s.uuid, svc.uuid))) return;
  store.state.gatt.services = [...store.state.gatt.services, svc];
  if (conn && conn.setGattTable) conn.setGattTable(store.state.gatt);
}
