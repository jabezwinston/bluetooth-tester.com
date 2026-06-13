// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Single source of truth for the app's identity — used by the About dialog and stamped into
// exported PCAPNG files (Section Header / Interface Description blocks). Bump APP_VERSION here.

export const APP_NAME = 'Bluetooth Tester';
export const APP_VERSION = '0.5.0';
export const APP_SITE = 'bluetooth-tester.com';
export const APP_REPO = 'https://github.com/jabezwinston/bluetooth-tester.com';

// Stamp an exported JSON object with its origin (site + tool version), placed first. Any existing
// site/version on the payload is dropped so the current values always win (no stale/duplicate keys).
export function stampExport(obj) {
  const rest = { ...obj };
  delete rest.site;
  delete rest.version;
  return { site: APP_SITE, version: APP_VERSION, ...rest };
}
