// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Plain-English help for form fields + controller features, shown in the ⓘ tooltips (see help-tip.js).
// This file is DATA ONLY and is the place to edit wording — no UI logic here. Each entry: { text, spec? }
// where text is one or two simple sentences ("what it is + why it matters") and the optional spec =
// { cite, url } links to the Bluetooth SIG. Keys are namespaced by panel: adv.* conn.* smp.* gatt.*
// client.* dtm.* ctrl.* — and ctrl.feat.<bit> for the LE feature bits.

// Core 6.0 is published as HTML, one page per Volume/Part. Section anchors are UUID-based (not numeric),
// so we link to the part page and put the exact § in the citation.
const BASE = 'https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core-60/out/en/';
const HCI = BASE + 'host-controller-interface/host-controller-interface-functional-specification.html';
const LL = BASE + 'low-energy-controller/link-layer-specification.html';
const DTM = BASE + 'low-energy-controller/direct-test-mode.html';
const GAP = BASE + 'host/generic-access-profile.html';
const SMP = BASE + 'host/security-manager-specification.html';
const GATT = BASE + 'host/generic-attribute-profile--gatt-.html';
const ATT = BASE + 'host/attribute-protocol--att-.html';
// Appearance / UUIDs / Company IDs / AD data-type codes live in the Assigned Numbers document.
const ASSIGNED = 'https://www.bluetooth.com/specifications/assigned-numbers/';

export const HELP = {
  // ---- Advertiser: payload fields ----
  'adv.flags': {
    text: 'Tells scanners the basics about this device — whether it is discoverable, and whether it is LE-only or also supports classic Bluetooth. Most LE devices send “General Discoverable + BR/EDR Not Supported”.',
    spec: { cite: 'Assigned Numbers — Common Data Types: Flags', url: ASSIGNED },
  },
  'adv.uuids16': {
    text: 'The short (16-bit) IDs of the standard services this device offers, so a scanner can tell at a glance what it does (e.g. 0x180F = Battery). Lets apps filter for devices they care about.',
    spec: { cite: 'Assigned Numbers — 16-bit UUIDs (Service UUIDs)', url: ASSIGNED },
  },
  'adv.uuids128': {
    text: 'Full-length (128-bit) IDs for custom/vendor services that don’t have a short number. Same purpose as 16-bit UUIDs but for non-standard services.',
    spec: { cite: 'Assigned Numbers — UUIDs', url: ASSIGNED },
  },
  'adv.appearance': {
    text: 'What kind of device this is (phone, watch, keyboard, thermometer…). A central may show a matching icon for it. Cosmetic — it does not change how the device behaves.',
    spec: { cite: 'Assigned Numbers §2.6 — Appearance Values', url: ASSIGNED },
  },
  'adv.txPower': {
    text: 'The radio power the device claims to transmit at, in dBm. A receiver compares it with the measured signal to roughly estimate distance.',
    spec: { cite: 'Assigned Numbers — Common Data Types: Tx Power Level', url: ASSIGNED },
  },
  'adv.manufacturer': {
    text: 'Free-form vendor data tagged with a company ID — used by beacons and proprietary protocols (e.g. iBeacon, Find My). The first two bytes are the assigned Company Identifier.',
    spec: { cite: 'Assigned Numbers §7 — Company Identifiers', url: ASSIGNED },
  },
  'adv.serviceData': {
    text: 'Live data attached to a specific service UUID and broadcast in the advertisement, so a scanner can read it without connecting (e.g. a sensor’s current value).',
    spec: { cite: 'Assigned Numbers — Common Data Types: Service Data', url: ASSIGNED },
  },
  'adv.name': {
    text: 'The human-readable name shown in scan lists (e.g. “My Sensor”). “Complete” is the full name; “Short” is a truncated version used when space is tight.',
    spec: { cite: 'Assigned Numbers — Common Data Types: Local Name', url: ASSIGNED },
  },

  // ---- Advertiser: parameters ----
  'adv.type': {
    text: 'What kind of advertisement to send: connectable (a central can connect), scannable (can be asked for extra scan-response data), or non-connectable beacon. Directed types target one known peer for fast reconnection.',
    spec: { cite: 'Core Spec Vol 6 Part B §4.4.2 — Advertising', url: LL },
  },
  'adv.intervalMin': {
    text: 'The shortest gap between advertisements. The controller picks an interval between min and max. Shorter = found faster but uses more power.',
    spec: { cite: 'Core Spec Vol 6 Part B §4.4.2.2 — Advertising interval', url: LL },
  },
  'adv.intervalMax': {
    text: 'The longest gap between advertisements. The controller advertises somewhere between min and max. Longer = lower power but slower to be discovered.',
    spec: { cite: 'Core Spec Vol 6 Part B §4.4.2.2 — Advertising interval', url: LL },
  },
  'adv.ownAddress': {
    text: 'Which address the device advertises from: a fixed Public address, a Random Static address, or a privacy address that rotates. Affects whether the device can be tracked.',
    spec: { cite: 'Core Spec Vol 6 Part B §1.3 — Device Address', url: LL },
  },
  'adv.randomAddress': {
    text: 'The random address used when “Own address type” is Random. The top two bits mark it as a static random address (stable until reboot).',
    spec: { cite: 'Core Spec Vol 6 Part B §1.3.2 — Random Device Address', url: LL },
  },
  'adv.channels': {
    text: 'Which of the three primary advertising channels (37, 38, 39) to use. All three is normal; limiting them can dodge interference but makes the device harder to find.',
    spec: { cite: 'Core Spec Vol 6 Part B §4.4.2.1 — Advertising channels', url: LL },
  },
  'adv.peerAddress': {
    text: 'For directed advertising, the address of the specific central you want to reconnect to. Ignored for normal (undirected) advertising.',
    spec: { cite: 'Core Spec Vol 6 Part B §4.4.2 — Directed advertising', url: LL },
  },

  // ---- Advertiser: extended ----
  'adv.mode': {
    text: 'Legacy advertising is capped at 31 bytes; Extended (Bluetooth 5) moves the data to secondary channels and allows much larger payloads and 2M/Coded PHYs. Use Extended when 31 bytes isn’t enough.',
    spec: { cite: 'Core Spec Vol 6 Part B §4.4.2 — Extended advertising', url: LL },
  },
  'adv.primaryPhy': {
    text: 'The radio mode used on the primary channels for extended advertising — 1M (standard) or Coded (long range, slower). This is what scanners first hear.',
    spec: { cite: 'Core Spec Vol 6 Part B §4.4.2 — Advertising PHYs', url: LL },
  },
  'adv.secondaryPhy': {
    text: 'The radio mode for the secondary channel that carries the actual extended payload — 1M, 2M (faster) or Coded (long range).',
    spec: { cite: 'Core Spec Vol 6 Part B §4.4.2 — Advertising PHYs', url: LL },
  },
  'adv.sid': {
    text: 'Advertising Set ID (0–15): a tag that lets a scanner tell apart multiple advertising sets coming from the same device.',
    spec: { cite: 'Core Spec Vol 6 Part B §4.4.2 — Advertising SID', url: LL },
  },
  'adv.duration': {
    text: 'How long the controller keeps advertising this set before stopping on its own. 0 means advertise forever.',
    spec: { cite: 'Core Spec Vol 4 Part E §7.8.56 — LE Set Extended Advertising Enable', url: HCI },
  },
  'adv.maxEvents': {
    text: 'Stop after this many advertising events, regardless of time. 0 means no limit.',
    spec: { cite: 'Core Spec Vol 4 Part E §7.8.56 — LE Set Extended Advertising Enable', url: HCI },
  },
  'adv.rawAdv': {
    text: 'Extra raw advertising bytes appended as-is, for hand-crafting AD structures the form doesn’t cover. Advanced use.',
    spec: { cite: 'Assigned Numbers — Common Data Types (AD format)', url: ASSIGNED },
  },
  'adv.rawScan': {
    text: 'Extra raw bytes appended to the scan response (the extra data sent when a scanner asks). Advanced use.',
    spec: { cite: 'Assigned Numbers — Common Data Types (AD format)', url: ASSIGNED },
  },

  // ---- Connections (parameter update) ----
  'conn.intervalMin': {
    text: 'Shortest time between connection events (data exchanges). Shorter = lower latency but more power.',
    spec: { cite: 'Core Spec Vol 6 Part B §4.5.1 — Connection interval', url: LL },
  },
  'conn.intervalMax': {
    text: 'Longest acceptable time between connection events. The two ends agree on a value within min..max.',
    spec: { cite: 'Core Spec Vol 6 Part B §4.5.1 — Connection interval', url: LL },
  },
  'conn.latency': {
    text: 'How many connection events the peripheral may skip when it has nothing to send. Saves power while staying responsive when data is ready.',
    spec: { cite: 'Core Spec Vol 6 Part B §4.5.1 — Peripheral latency', url: LL },
  },
  'conn.timeout': {
    text: 'How long without a successful exchange before the link is declared lost. Must be comfortably longer than interval × (latency + 1).',
    spec: { cite: 'Core Spec Vol 6 Part B §4.5.2 — Supervision timeout', url: LL },
  },
  'conn.localRole': {
    text: 'Whether this device is the Central (it opened the connection and drives the timing) or the Peripheral (it accepted the connection). A device advertising and getting connected is the Peripheral.',
    spec: { cite: 'Core Spec Vol 3 Part C §2.2.2 — LE roles', url: GAP },
  },
  'conn.interval': {
    text: 'The connection interval currently in effect — the actual time between data exchanges that the two devices agreed on. Lower feels snappier; higher saves power.',
    spec: { cite: 'Core Spec Vol 6 Part B §4.5.1 — Connection interval', url: LL },
  },
  'conn.attMtu': {
    text: 'The largest ATT payload the two sides agreed to use. A bigger MTU means long reads/writes need fewer round-trips. The default before negotiation is 23 bytes.',
    spec: { cite: 'Core Spec Vol 3 Part F §3.2.9 — Exchange MTU', url: ATT },
  },
  'conn.subscriptions': {
    text: 'Which of this device’s characteristics the connected central has turned on notifications/indications for (by writing their CCCD).',
    spec: { cite: 'Core Spec Vol 3 Part G §3.3.3.3 — Client Characteristic Configuration', url: GATT },
  },
  'conn.remoteLmpVersion': {
    text: 'The Bluetooth Core version of the remote device’s controller (its link-layer), read after connecting.',
    spec: { cite: 'Core Spec Vol 4 Part E §7.1.23 — Read Remote Version Information', url: HCI },
  },
  'conn.remoteManufacturer': {
    text: 'The company that made the remote device’s controller, decoded from its assigned Company Identifier.',
    spec: { cite: 'Assigned Numbers §7 — Company Identifiers', url: ASSIGNED },
  },
  'conn.remoteSubversion': {
    text: 'A vendor-specific build/revision number of the remote controller. No standard meaning across vendors.',
    spec: { cite: 'Core Spec Vol 4 Part E §7.1.23 — Read Remote Version Information', url: HCI },
  },

  // ---- SMP (pairing / security) ----
  'smp.acceptPairing': {
    text: 'Whether to allow pairing at all. Turn off to refuse pairing and keep an unencrypted (transparent) connection — useful for testing how a peer reacts.',
    spec: { cite: 'Core Spec Vol 3 Part H §2.3 — Pairing', url: SMP },
  },
  'smp.io': {
    text: 'What input/output this device claims to have (display, keyboard, yes/no button, or none). It decides which pairing method is used and whether it resists man-in-the-middle attacks.',
    spec: { cite: 'Core Spec Vol 3 Part H §2.3.2 — IO Capabilities', url: SMP },
  },
  'smp.sc': {
    text: 'LE Secure Connections uses modern (ECDH) key exchange, far stronger than the original “Legacy” pairing. Leave on unless testing an old device.',
    spec: { cite: 'Core Spec Vol 3 Part H §2.3.5.6 — LE Secure Connections', url: SMP },
  },
  'smp.mitm': {
    text: 'Ask for man-in-the-middle protection — forces an authenticated method (passkey or numeric compare) instead of unauthenticated “Just Works”. Needs real IO capability.',
    spec: { cite: 'Core Spec Vol 3 Part H §2.3.5 — Authentication requirements', url: SMP },
  },
  'smp.bonding': {
    text: 'Whether to store the keys after pairing so the two devices can reconnect securely without pairing again (“bonding”).',
    spec: { cite: 'Core Spec Vol 3 Part H §2.3.1 — Security properties (Bonding)', url: SMP },
  },
  'smp.maxKey': {
    text: 'Largest encryption key size to negotiate, 7–16 bytes. 16 is strongest; smaller is only for interop with limited devices.',
    spec: { cite: 'Core Spec Vol 3 Part H §2.3.4 — Encryption key size', url: SMP },
  },
  'smp.passkey': {
    text: 'A fixed 6-digit passkey to use instead of a random one, so you can script repeatable passkey-entry pairing in tests.',
    spec: { cite: 'Core Spec Vol 3 Part H §2.3.5.3 — Passkey Entry', url: SMP },
  },

  // ---- GATT Server ----
  'gatt.uuid': {
    text: 'The unique ID of this service or characteristic — a short 16-bit number for standard ones, or a 128-bit UUID for custom ones.',
    spec: { cite: 'Assigned Numbers — GATT Services/Characteristics', url: ASSIGNED },
  },
  'gatt.properties': {
    text: 'What a client is allowed to do with this characteristic: Read, Write, Write-without-response, Notify (server pushes updates), or Indicate (push with acknowledgement).',
    spec: { cite: 'Core Spec Vol 3 Part G §3.3.1.1 — Characteristic Properties', url: GATT },
  },
  'gatt.security': {
    text: 'The protection required to access this value — e.g. none, encryption, or authenticated (paired with MITM). The server rejects access that doesn’t meet it.',
    spec: { cite: 'Core Spec Vol 3 Part G §8.1 — Attribute permissions', url: GATT },
  },
  'gatt.valueType': {
    text: 'How to interpret the stored bytes (raw hex or text) so the value is shown and edited sensibly.',
    spec: { cite: 'Core Spec Vol 3 Part G §3.3.1 — Characteristic Value', url: GATT },
  },
  'gatt.value': {
    text: 'The actual bytes a client reads, or that you push as a notification. Edit in hex or text per the value type.',
    spec: { cite: 'Core Spec Vol 3 Part G §3.3.1 — Characteristic Value', url: GATT },
  },

  // ---- GATT Client ----
  'client.discover': {
    text: 'Ask the connected device for its list of services and characteristics, so you can read, write, or subscribe to them.',
    spec: { cite: 'Core Spec Vol 3 Part G §4.4 — Service Discovery', url: GATT },
  },
  'client.write': {
    text: 'Send bytes to a characteristic. “With response” waits for an acknowledgement; “without response” is fire-and-forget (faster, no confirmation).',
    spec: { cite: 'Core Spec Vol 3 Part G §4.9 — Characteristic Value Write', url: GATT },
  },
  'client.subscribe': {
    text: 'Turn on notifications/indications so the device pushes updates to you (by writing its CCCD) instead of you polling.',
    spec: { cite: 'Core Spec Vol 3 Part G §3.3.3.3 — Client Characteristic Configuration', url: GATT },
  },

  // ---- RF Test (Direct Test Mode) ----
  'dtm.channel': {
    text: 'The physical RF channel to test on: 0–39, where frequency = 2402 + 2×N MHz (ch 0 = 2402, ch 39 = 2480). Note this is the RF channel, not the BLE channel index — a sniffer labels 2402/2426/2480 MHz as advertising channels 37/38/39.',
    spec: { cite: 'Core Spec Vol 6 Part F — Direct Test Mode', url: DTM },
  },
  'dtm.phy': {
    text: 'The radio mode under test: 1M, 2M (faster), or Coded S=8/S=2 (long range). The receiver auto-detects the two Coded variants.',
    spec: { cite: 'Core Spec Vol 6 Part F §4.1 — DTM PHY', url: DTM },
  },
  'dtm.pattern': {
    text: 'The fixed bit pattern the transmitter sends (e.g. PRBS9, alternating, all-ones) so the receiver can check for errors.',
    spec: { cite: 'Core Spec Vol 6 Part F §4.1.5 — Packet payload', url: DTM },
  },
  'dtm.length': {
    text: 'How many payload bytes per test packet. Longer packets stress the radio more and change the packet rate.',
    spec: { cite: 'Core Spec Vol 6 Part F §4.1.5 — Packet payload', url: DTM },
  },
  'dtm.txPower': {
    text: 'Transmit power for the test, in dBm. Higher reaches further; used to characterise range and the receiver’s sensitivity.',
    spec: { cite: 'Core Spec Vol 6 Part F — Transmitter Test', url: DTM },
  },
  'dtm.modIndex': {
    text: 'Tells the receiver whether the transmitter uses a “standard” or “stable” modulation index — a fine radio characteristic, rarely changed.',
    spec: { cite: 'Core Spec Vol 6 Part F §4.1.4 — Modulation index', url: DTM },
  },

  // ---- Controller panel: Version ----
  'ctrl.hciVersion': {
    text: 'Which Bluetooth Core version the controller’s HCI implements (e.g. 5.4). Newer versions add more features.',
    spec: { cite: 'Core Spec Vol 4 Part E §7.4.1 — Read Local Version Information', url: HCI },
  },
  'ctrl.hciSubversion': {
    text: 'A vendor-specific revision number for the controller’s HCI build. No standard meaning across vendors.',
    spec: { cite: 'Core Spec Vol 4 Part E §7.4.1 — Read Local Version Information', url: HCI },
  },
  'ctrl.lmpVersion': {
    text: 'The Bluetooth Core version of the controller’s link-layer (Link Manager). Usually matches the HCI version.',
    spec: { cite: 'Core Spec Vol 4 Part E §7.4.1 — Read Local Version Information', url: HCI },
  },
  'ctrl.manufacturer': {
    text: 'The company that made the controller, decoded from its assigned Company Identifier.',
    spec: { cite: 'Assigned Numbers §7 — Company Identifiers', url: ASSIGNED },
  },
  'ctrl.bdAddr': {
    text: 'The controller’s public Bluetooth address — its fixed factory identity. All-zero means it has no public address and will advertise from a random one instead.',
    spec: { cite: 'Core Spec Vol 6 Part B §1.3 — Device Address', url: LL },
  },
  'ctrl.txPower': {
    text: 'The controller’s advertising transmit power in dBm, if it reports one.',
    spec: { cite: 'Core Spec Vol 4 Part E §7.8.6 — LE Read Advertising Physical Channel Tx Power', url: HCI },
  },

  // ---- Controller panel: Buffers ----
  'ctrl.aclLen': {
    text: 'Largest classic (BR/EDR) data packet the controller can buffer. Not applicable to LE-only controllers.',
    spec: { cite: 'Core Spec Vol 4 Part E §7.4.5 — Read Buffer Size', url: HCI },
  },
  'ctrl.aclPackets': {
    text: 'How many classic data packets the controller can hold at once. Not applicable to LE-only controllers.',
    spec: { cite: 'Core Spec Vol 4 Part E §7.4.5 — Read Buffer Size', url: HCI },
  },
  'ctrl.leAclLen': {
    text: 'Largest LE data payload the host may hand the controller in one packet.',
    spec: { cite: 'Core Spec Vol 4 Part E §7.8.2 — LE Read Buffer Size', url: HCI },
  },
  'ctrl.leAclPackets': {
    text: 'How many LE data packets the controller can buffer at once — used for flow control.',
    spec: { cite: 'Core Spec Vol 4 Part E §7.8.2 — LE Read Buffer Size', url: HCI },
  },
  'ctrl.maxAdvData': {
    text: 'The biggest advertising payload this controller accepts — 31 bytes for legacy, more with extended advertising.',
    spec: { cite: 'Core Spec Vol 4 Part E §7.8.57 — LE Read Maximum Advertising Data Length', url: HCI },
  },
  'ctrl.advSets': {
    text: 'How many independent advertising sets the controller can run at the same time (extended advertising).',
    spec: { cite: 'Core Spec Vol 4 Part E §7.8.58 — LE Read Number of Supported Advertising Sets', url: HCI },
  },

  // ---- Controller panel: Misc ----
  'ctrl.supportedCommands': {
    text: 'How many HCI commands the controller says it supports, counted from its Supported_Commands bitmap.',
    spec: { cite: 'Core Spec Vol 4 Part E §7.4.2 — Read Local Supported Commands', url: HCI },
  },
  'ctrl.leFeaturesRaw': {
    text: 'The raw LE feature bitmask the controller reported — decoded into the readable list under “LE Features”.',
    spec: { cite: 'Core Spec Vol 6 Part B §4.6 — Feature Support', url: LL },
  },

  // ---- Controller panel: LE feature bits (ctrl.feat.<bit>) ----
  'ctrl.feat.0': { text: 'LE Encryption: the controller can encrypt connections (AES-CCM). Required for pairing/bonding to protect data over the air.', spec: { cite: 'Core Spec Vol 6 Part B §4.6 — Feature Support', url: LL } },
  'ctrl.feat.1': { text: 'Connection Parameters Request: either side can ask to change the connection timing (interval/latency/timeout) after connecting.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.2', url: LL } },
  'ctrl.feat.2': { text: 'Extended Reject Indication: richer error reporting when a link-layer control procedure is rejected.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.3', url: LL } },
  'ctrl.feat.3': { text: 'Peripheral-initiated Features Exchange: the peripheral (not just the central) can start exchanging the list of supported features.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.4', url: LL } },
  'ctrl.feat.4': { text: 'LE Ping: a keep-alive that checks an encrypted link is still alive and the keys are still valid.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.5', url: LL } },
  'ctrl.feat.5': { text: 'LE Data Packet Length Extension: allows bigger data packets (up to 251 bytes) for higher throughput.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.6', url: LL } },
  'ctrl.feat.6': { text: 'LL Privacy: the controller can use rotating private (resolvable) addresses so the device can’t be tracked.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.7', url: LL } },
  'ctrl.feat.7': { text: 'Extended Scanner Filter Policies: more flexible rules for which advertisers a scanner accepts.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.8', url: LL } },
  'ctrl.feat.8': { text: 'LE 2M PHY: a 2 Mbit/s radio mode — double the data rate of the original 1M, at somewhat shorter range.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.9', url: LL } },
  'ctrl.feat.9': { text: 'Stable Modulation Index – Tx: the transmitter keeps a tight, stable modulation, letting receivers decode more reliably.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.10', url: LL } },
  'ctrl.feat.10': { text: 'Stable Modulation Index – Rx: the receiver can take advantage of transmitters that have a stable modulation index.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.11', url: LL } },
  'ctrl.feat.11': { text: 'LE Coded PHY: a long-range radio mode that trades speed for range using error-correcting coding (S=2 or S=8).', spec: { cite: 'Core Spec Vol 6 Part B §4.6.12', url: LL } },
  'ctrl.feat.12': { text: 'LE Extended Advertising: Bluetooth-5 advertising that lifts the 31-byte limit and adds more channels and PHYs.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.13', url: LL } },
  'ctrl.feat.13': { text: 'LE Periodic Advertising: lets receivers sync to a regular, connectionless broadcast schedule.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.14', url: LL } },
  'ctrl.feat.14': { text: 'Channel Selection Algorithm #2: a newer, more robust way of hopping across channels to avoid interference.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.15', url: LL } },
  'ctrl.feat.15': { text: 'LE Power Class 1: supports higher transmit power (Power Class 1) for longer range.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.16', url: LL } },
  'ctrl.feat.16': { text: 'Minimum Number of Used Channels: a device can request that the connection use at least a certain number of channels.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.17', url: LL } },
  'ctrl.feat.17': { text: 'Connection CTE Request: can ask the peer to add a Constant Tone Extension, used for direction finding (AoA/AoD).', spec: { cite: 'Core Spec Vol 6 Part B §4.6.18', url: LL } },
  'ctrl.feat.18': { text: 'Connection CTE Response: can add a Constant Tone Extension when asked, for direction finding.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.19', url: LL } },
  'ctrl.feat.19': { text: 'Connectionless CTE Tx: can transmit direction-finding tones in periodic advertising (no connection needed).', spec: { cite: 'Core Spec Vol 6 Part B §4.6.20', url: LL } },
  'ctrl.feat.20': { text: 'Connectionless CTE Rx: can receive direction-finding tones from periodic advertising.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.21', url: LL } },
  'ctrl.feat.21': { text: 'Antenna Switching During CTE Tx (AoD): switches antennas while sending the tone, enabling Angle-of-Departure direction finding.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.22', url: LL } },
  'ctrl.feat.22': { text: 'Antenna Switching During CTE Rx (AoA): switches antennas while receiving the tone, enabling Angle-of-Arrival direction finding.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.23', url: LL } },
  'ctrl.feat.23': { text: 'Receiving Constant Tone Extension: can receive and sample a CTE for direction finding.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.24', url: LL } },
  'ctrl.feat.24': { text: 'Periodic Adv Sync Transfer – Sender: can hand off the info needed to sync to a periodic advertiser to another device.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.25', url: LL } },
  'ctrl.feat.25': { text: 'Periodic Adv Sync Transfer – Recipient: can receive a periodic-advertising sync hand-off from another device.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.26', url: LL } },
  'ctrl.feat.26': { text: 'Sleep Clock Accuracy Updates: devices can tell each other about clock accuracy to save power and improve timing.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.27', url: LL } },
  'ctrl.feat.27': { text: 'Remote Public Key Validation: validates the peer’s public key during Secure Connections pairing, blocking certain attacks.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.28', url: LL } },
  'ctrl.feat.28': { text: 'Connected Isochronous Stream – Central: can act as the central of a CIS, used for two-way LE Audio streams.', spec: { cite: 'Core Spec Vol 6 Part B §4.6.29', url: LL } },
  'ctrl.feat.29': { text: 'Connected Isochronous Stream – Peripheral: can act as a peripheral in a CIS (LE Audio).', spec: { cite: 'Core Spec Vol 6 Part B §4.6.30', url: LL } },
  'ctrl.feat.30': { text: 'Isochronous Broadcaster: can broadcast isochronous audio streams to many listeners (Auracast / LE Audio).', spec: { cite: 'Core Spec Vol 6 Part B §4.6.31', url: LL } },
  'ctrl.feat.31': { text: 'Synchronized Receiver: can receive broadcast isochronous audio streams (Auracast / LE Audio).', spec: { cite: 'Core Spec Vol 6 Part B §4.6.32', url: LL } },
};

// Per-option help for dropdowns — shown as the native tooltip when you hover (wait on) an option in an
// open <select>. Plain short text (native title can't be styled or hold a link). Keyed 'select.value'.
export const OPT_HELP = {
  // Advertiser → Type
  'advType.ADV_IND': 'Connectable and scannable, undirected — the normal “anyone can find and connect” advertisement.',
  'advType.ADV_DIRECT_IND_HIGH': 'Directed at one known central for fast reconnection; high duty cycle (quick but only advertises briefly).',
  'advType.ADV_SCAN_IND': 'Scannable but not connectable — a beacon that can return extra scan-response data when asked.',
  'advType.ADV_NONCONN_IND': 'Non-connectable, non-scannable beacon — broadcast only; nothing can connect or query it.',
  'advType.ADV_DIRECT_IND_LOW': 'Directed at one known central; low duty cycle (slower to reconnect but advertises for longer).',
  // Advertiser → Own address type
  'ownAddr.public': 'Advertise from the controller’s fixed public address — stable, but trackable.',
  'ownAddr.random': 'Advertise from a random static address set by the app — stable until the device reboots.',
  // SMP → IO capability
  'io.3': 'No display or buttons. Pairing falls back to “Just Works” — no protection against man-in-the-middle.',
  'io.0': 'Can show a number but has no input. Used for Passkey Display pairing.',
  'io.1': 'Can show a number and confirm yes/no. Enables Numeric Comparison under Secure Connections.',
  'io.2': 'Can type a number but has no display. Used for Passkey Entry pairing.',
  'io.4': 'Has both a keyboard and a display — the most capable; supports every pairing method.',
};

/** Native-title text for a dropdown option, or '' if none. Use as `attrs: { title: optHelp(key) }`. */
export function optHelp(key) { return OPT_HELP[key] || ''; }
