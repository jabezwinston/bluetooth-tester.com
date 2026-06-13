// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// HCI controller firmware the app knows about, built by scripts/build-firmware.sh into
// firmware/<id>/. `method` decides how it's flashed:
//   esptool  — ESP32-family serial ROM loader, flashed in-app over Web Serial.
//   nrf-dfu  — Nordic USB serial DFU (nRF52840 dongle), flashed in-app after a RESET button press.
//   jlink    — DK boards with onboard J-Link; a browser can't drive them, so we offer the .hex
//              download + a `west flash`/nrfjprog command.
// ESP offsets are the Zephyr "simple boot" single-image addresses (esp32=0x1000, S3/C3/C6=0x0).
//
// Attribution: the firmware images referenced here (firmware/<id>/) are built from Zephyr's
// samples/bluetooth/hci_uart (Apache-2.0) — see scripts/build-firmware.sh and firmware/overlays/.

export const CHIPS = {
  esp32:    { label: 'ESP32',        family: 'ESP32', method: 'esptool', images: [{ offset: 0x1000, file: 'firmware/esp32/app.bin' }] },
  esp32s3:  { label: 'ESP32-S3',     family: 'ESP32', method: 'esptool', images: [{ offset: 0x0, file: 'firmware/esp32s3/app.bin' }] },
  esp32c3:  { label: 'ESP32-C3',     family: 'ESP32', method: 'esptool', images: [{ offset: 0x0, file: 'firmware/esp32c3/app.bin' }] },
  esp32c6:  { label: 'ESP32-C6',     family: 'ESP32', method: 'esptool', images: [{ offset: 0x0, file: 'firmware/esp32c6/app.bin' }] },
  nrf52840dongle: {
    label: 'nRF52840 Dongle', family: 'Nordic', method: 'nrf-dfu',
    init: 'firmware/nrf52840dongle/init.dat', image: 'firmware/nrf52840dongle/app.bin',
    reset: 'Press the dongle’s RESET button (the red LED pulses), then pick the bootloader port (1915:521F) when prompted.',
  },
  nrf52832dk: { label: 'nRF52 DK (nRF52832)', family: 'Nordic', method: 'jlink', hex: 'firmware/nrf52832dk/firmware.hex', board: 'nrf52dk/nrf52832' },
  nrf52833dk: { label: 'nRF52833 DK', family: 'Nordic', method: 'jlink', hex: 'firmware/nrf52833dk/firmware.hex', board: 'nrf52833dk/nrf52833' },
  nrf52840dk: { label: 'nRF52840 DK', family: 'Nordic', method: 'jlink', hex: 'firmware/nrf52840dk/firmware.hex', board: 'nrf52840dk/nrf52840' },
  nrf5340:  { label: 'nRF5340 DK',   family: 'Nordic', method: 'jlink', hex: 'firmware/nrf5340/firmware.hex', board: 'nrf5340dk/nrf5340/cpunet' },
  nrf54l15: { label: 'nRF54L15 DK',  family: 'Nordic', method: 'jlink', hex: 'firmware/nrf54l15/firmware.hex', board: 'nrf54l15dk/nrf54l15/cpuapp' },
};

export const CHIP_IDS = Object.keys(CHIPS);

/** Best-effort chip guess from the connected port's USB VID/PID (the prompt lets the user override). */
export function chipHint(info = {}) {
  const vid = info.usbVendorId, pid = info.usbProductId;
  if (vid === 0x1915 && pid === 0x521f) return 'nrf52840dongle'; // Nordic Open Bootloader (already in DFU)
  if (vid === 0x1915 || vid === 0x2fe3) return 'nrf52840dongle'; // Nordic / Zephyr USB (dongle running fw)
  if (vid === 0x303a) return 'esp32s3';                          // Espressif native USB Serial/JTAG (S3/C3/C6)
  if (vid === 0x10c4 || vid === 0x1a86 || vid === 0x0403) return 'esp32'; // CP210x / CH34x / FTDI bridge → an ESP DevKit
  if (vid === 0x1366) return 'nrf52840dk';                       // SEGGER J-Link VCOM → an nRF DK (default to 52840)
  return null;
}

/**
 * Serial open() parameters for a freshly-picked port when a board needs something other than the
 * default 115200/none. The nRF DK boards expose their Zephyr hci_uart over the onboard SEGGER J-Link
 * VCOM (VID 0x1366) at 1 Mbaud with RTS/CTS hardware flow control — auto-select those so a user on the
 * defaults isn't met with "no HCI". Returns null to keep the user's chosen baud/flow control otherwise.
 */
export function serialParamsFor(info = {}) {
  if (info.usbVendorId === 0x1366) return { baudRate: 1000000, flowControl: 'hardware' };
  return null;
}

/** True for an ESP USB-UART bridge (CP210x / CH34x / FTDI) that uses the DTR/RTS auto-reset circuit. */
export function isEspUartBridge(info = {}) {
  return [0x10c4, 0x1a86, 0x0403].includes(info.usbVendorId);
}

/**
 * True for an ESP32-S3/C3/C6 connected over its *integrated* USB-Serial/JTAG (VID 0x303A), not the
 * external UART bridge. The bundled HCI firmware routes HCI onto UART0, so HCI only works via the
 * board's UART-bridge port — flashing over native USB succeeds but leaves HCI unreachable. The UI
 * uses this to steer the user to the UART port instead of silently dead-ending.
 */
export function isEspNativeUsb(info = {}) {
  return info.usbVendorId === 0x303a;
}

/**
 * True for the nRF52840 dongle in its Nordic Open DFU Bootloader (VID:PID 1915:521F). This is a DFU
 * device, not an HCI controller — recognized purely by VID:PID so we never send it an HCI Reset (that
 * would land in its DFU receive buffer and corrupt the first real DFU command); it routes straight to
 * the guided DFU flash wizard.
 */
export function isNrfDfuBootloader(info = {}) {
  return info.usbVendorId === 0x1915 && info.usbProductId === 0x521f;
}

/** Download filename for a board's bundled HCI-UART firmware (also referenced by flashCommand). */
export function firmwareFileName(chipId) {
  const c = CHIPS[chipId];
  const ext = c.method === 'jlink' ? 'hex' : c.method === 'nrf-dfu' ? 'zip' : 'bin';
  return `${chipId}_hci_uart.${ext}`;
}

/** Out-of-app CLI command to flash a board's bundled firmware (shown beside the download for every board). */
export function flashCommand(chipId) {
  const c = CHIPS[chipId];
  const file = firmwareFileName(chipId);
  if (c.method === 'jlink') {
    const co = chipId === 'nrf5340' ? ' --coprocessor CP_NETWORK' : '';
    return `nrfjprog${co} --program ${file} --chiperase --verify -r`;
  }
  if (c.method === 'nrf-dfu') {
    return `nrfutil dfu usb-serial -pkg ${file} -p <PORT>`;
  }
  // esptool — single Zephyr simple-boot image at the chip's flash offset.
  const off = '0x' + c.images[0].offset.toString(16);
  return `esptool.py --chip ${chipId} --port <PORT> --baud 921600 write_flash ${off} ${file}`;
}
