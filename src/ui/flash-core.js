// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Flash orchestration shared by the OOB wizard and the Firmware panel. Fetches the bundled firmware
// (firmware/<chip>/…, built by scripts/build-firmware.sh) and drives the right flasher: ESP32-family via
// the esptool serial ROM (keeping the live HCI connection), the nRF52840 dongle via Nordic serial DFU.

import { EspFlasher, SlipReader } from '../esp/esp-flasher.js';
import { FlashSerial } from '../esp/flash-serial.js';
import { NrfDfu } from '../nrf/nrf-dfu.js';
import { DfuSerial } from '../nrf/dfu-serial.js';
import { CHIPS, isEspUartBridge } from '../data/firmware-manifest.js';
import { bringUp } from '../host/controller.js';
import { zipStore } from '../util/zip.js';

async function fetchBin(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`firmware not found: ${url} — run scripts/build-firmware.sh`);
  return new Uint8Array(await r.arrayBuffer());
}

// esp-flasher chip name ("ESP32-C3") → firmware-manifest id ("esp32c3").
const detectedId = (name) => name.toLowerCase().replace(/-/g, '');

/**
 * Flash ESP HCI firmware while KEEPING the live WebSerial connection — the path used by both the OOB
 * wizard and the Firmware tab. Borrows the open HCI port (transport.detach: release locks, keep open),
 * drives the ROM flasher over it, then hands it back and brings HCI up on the SAME connection, so the
 * port never closes and the user is never re-prompted for a port.
 *
 * Auto-detect-and-flash: the exact chip is read from its ROM magic and we flash THAT chip's firmware, so
 * a mismatched (bricking) image is structurally impossible regardless of any dropdown hint.
 *
 * `onPhase(name, detail)` drives the wizard step UI:
 *   'auto-reset'{attempt} | 'manual-boot' | 'detecting' | 'detected'(chip) | 'flashing'(chip) | 'verifying'
 * `signal` is an AbortSignal (Cancel during the BOOT wait). Returns { ready, chip }. On cancel/error the
 * still-open port is handed back to the transport so the connection survives.
 */
export async function flashEspKeepConnection({ transport, hci, store, signal, onPhase = () => {}, onProgress = () => {}, log = () => {} }) {
  const serial = new FlashSerial();
  serial.onLog = log;
  const slip = new SlipReader();
  const flasher = new EspFlasher(
    {
      write: (b) => serial.write(b),
      resetToBootloader: (attempt) => serial.bootloaderReset(attempt),
      resetToRun: () => serial.rtsReset(800),
      resetManualBoot: () => serial.manualBootReset(),
      setBaud: (b) => serial.reopen({ baudRate: b }),
    },
    slip, { log, onProgress },
  );

  let port = null;
  try {
    port = await transport.detach();            // release the HCI locks; keep the SAME port open
    if (!port) throw new Error('no open connection to borrow — connect first');
    serial.adopt(port);                         // take the open port over (no close/reopen, no picker)
    serial.onBytes = (b) => slip.feed(b);
    serial.startReading();

    const chip = await flasher.connect({ signal, onPhase }); // rotates reset; waits for BOOT if needed
    const id = detectedId(chip.name);
    const manifest = CHIPS[id];
    if (!manifest || manifest.method !== 'esptool') throw new Error(`detected ${chip.name}, which has no bundled HCI firmware`);

    onPhase('flashing', manifest);
    const images = [];
    for (const im of manifest.images) images.push({ offset: im.offset, label: id, data: await fetchBin(im.file) });
    log(`loaded ${images.reduce((n, i) => n + i.data.length, 0)} bytes for ${manifest.label}`);
    // The kept connection stays at the session baud (115200 = ROM download baud); changing baud needs a
    // port reopen, which would drop the connection — so we flash at 115200 to preserve it.
    await flasher.flashImages(images);
    await flasher.finish({ reset: false });     // the verify step below drives the authoritative reboot
    log('✓ flashed — resuming HCI on the same connection…');
    await serial.release();                     // drop the flasher's locks; leave the port OPEN

    // Verify: hand the still-open port back, boot the new firmware, and bring the controller up. The
    // ESP prints a boot banner on UART0 here; espRunReset drains it and bringUp's probeReset is
    // boot-banner safe (flush+resync between Reset tries), so HCI comes up cleanly.
    onPhase('verifying');
    transport.reattach(port);
    if (isEspUartBridge(port.getInfo?.() || {})) await transport.espRunReset();
    const c = await bringUp(hci, store);
    return { ready: !!c.ready, chip: c };
  } catch (e) {
    // Cancel/error: drop the flasher's locks and hand the still-open port back so the connection lives.
    try { await serial.release(); } catch {}
    if (port && !transport.port) { try { transport.reattach(port); } catch {} }
    throw e;
  }
}

/**
 * Flash the nRF52840 dongle over Nordic serial DFU while it's already connected in bootloader mode
 * (1915:521F) — the OOB wizard path. Borrows the open port from the HCI transport (no re-prompt), runs
 * DFU, and lets the dongle reset. Unlike ESP this does NOT keep the connection: on the final Execute the
 * bootloader jumps to the freshly-flashed app, which re-enumerates as a different USB device — so the
 * caller must reconnect (a fresh port grant) to bring HCI up.
 */
export async function flashNrfDfuConnected({ transport, onProgress = () => {}, log = () => {} }) {
  const chip = CHIPS.nrf52840dongle;
  const init = await fetchBin(chip.init);
  const image = await fetchBin(chip.image);
  log(`loaded ${image.length}-byte image + ${init.length}-byte init packet`);
  const t = new DfuSerial();
  const port = await transport.detach();   // release the HCI locks; keep the bootloader port open
  if (!port) throw new Error('no open connection to borrow — connect first');
  await t.adopt(port);                      // asserts the CDC "port open" signal before the first DFU command
  try {
    await new NrfDfu(t, { log, onProgress }).flash(init, image);
    log('✓ programmed — the dongle is rebooting into the HCI firmware…');
    try { await t.close(); } catch {}  // success → the dongle re-enumerated; closing the dead port is harmless
  } catch (e) {
    // Flash failed — the dongle is usually still in bootloader. Hand the still-open port back to the HCI
    // transport so the connection survives and the user can Retry without reconnecting.
    try { const p = await t.release(); if (p && !transport.port) transport.reattach(p); } catch {}
    throw e;
  }
}

/**
 * Build the Nordic serial-DFU package (.zip) for the nRF52840 dongle from the bundled init packet + app
 * image, in the layout `nrfutil dfu usb-serial` / pc-nrfutil expects (manifest.json + init.dat + app.bin).
 * Lets a user flash the bundled firmware from the command line. Returns a Blob.
 */
export async function nrfDfuPackage() {
  const chip = CHIPS.nrf52840dongle;
  const init = await fetchBin(chip.init);
  const app = await fetchBin(chip.image);
  const manifest = JSON.stringify({ manifest: { application: { bin_file: 'app.bin', dat_file: 'init.dat' } } });
  return zipStore([
    { name: 'manifest.json', data: manifest },
    { name: 'init.dat', data: init },
    { name: 'app.bin', data: app },
  ]);
}

async function flashNrfDfu(chipId, { log = () => {}, onProgress = () => {} }) {
  const chip = CHIPS[chipId];
  const init = await fetchBin(chip.init);
  const image = await fetchBin(chip.image);
  log(`loaded ${image.length}-byte image + ${init.length}-byte init packet`);
  const t = new DfuSerial();
  try {
    await t.acquire(); // user selects the bootloader port (1915:521F)
    await t.open();
    await new NrfDfu(t, { log, onProgress }).flash(init, image);
    log('✓ programmed — reconnect from the header.');
  } finally {
    try { await t.close(); } catch {}
  }
}

/**
 * Flash `chipId`. ESP boards use flashEspKeepConnection() (keeps the live connection) — call that
 * directly. This entry serves the nRF52840 dongle (serial DFU); J-Link boards reject (use the .hex).
 */
export function flash(chipId, opts = {}) {
  const m = CHIPS[chipId]?.method;
  if (m === 'nrf-dfu') return flashNrfDfu(chipId, opts);
  if (m === 'esptool') return Promise.reject(new Error('ESP flashing keeps the live connection — use flashEspKeepConnection().'));
  return Promise.reject(new Error(`${CHIPS[chipId]?.label || chipId} uses J-Link — flash it with west/nrfjprog (download the .hex).`));
}
