// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Decode an HCI ACL data packet down through L2CAP into ATT / SMP / L2CAP-signaling, like
// Wireshark's protocol tree. Returns a one-line `summary` (for the log list) and `groups` (a
// nested field tree for the expanded detail view). Best-effort per packet: a continuation
// fragment or an L2CAP PDU split across ACL packets is flagged rather than reassembled.

import { ByteReader, bytesToHex } from '../util/bytes.js';
import { ATT_OP, ATT_OP_NAMES, ATT_ERR_NAMES } from '../host/att.js';
import { SMP_OP, SMP_FAIL_NAMES } from '../host/smp.js';
import { L2CAP_CID } from '../host/l2cap.js';
import { gattName } from '../profiles/gatt-decode.js';

const f = (name, value) => ({ name, value: String(value) });
const grp = (name, fields) => ({ name, fields });
const hex2 = (n) => (n & 0xff).toString(16).padStart(2, '0').toUpperCase();
const hex4 = (n) => (n & 0xffff).toString(16).padStart(4, '0').toUpperCase();
const handleStr = (h) => `0x${hex4(h)} (${h})`;
const pretty = (k) => k.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// ATT_OP_NAMES abbreviates (Req/Rsp/Ntf/…); expand to Wireshark-style full words.
const attName = (op) => (ATT_OP_NAMES[op] || `Unknown 0x${hex2(op)}`)
  .replace(/\bReq\b/, 'Request').replace(/\bRsp\b/, 'Response')
  .replace(/\bNtf\b/, 'Notification').replace(/\bInd\b/, 'Indication')
  .replace(/\bCmd\b/, 'Command').replace(/\bCfm\b/, 'Confirmation');
const SMP_OP_NAMES = Object.fromEntries(Object.entries(SMP_OP).map(([k, v]) => [v, pretty(k)]));
const IO_NAMES = ['DisplayOnly', 'DisplayYesNo', 'KeyboardOnly', 'NoInputNoOutput', 'KeyboardDisplay'];
const PB_NAMES = { 0: 'First (non-flushable)', 1: 'Continuation fragment', 2: 'First (flushable)', 3: 'Complete PDU' };
const SIG_NAMES = { 0x01: 'Command Reject', 0x06: 'Disconnection Request', 0x07: 'Disconnection Response', 0x12: 'Connection Parameter Update Request', 0x13: 'Connection Parameter Update Response' };

function uuidStr(bytes) {
  if (bytes.length === 2) return hex4(bytes[0] | (bytes[1] << 8));
  if (bytes.length === 16) {
    const be = Array.from(bytes).reverse().map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${be.slice(0, 8)}-${be.slice(8, 12)}-${be.slice(12, 16)}-${be.slice(16, 20)}-${be.slice(20)}`.toUpperCase();
  }
  return bytesToHex(bytes);
}
const uuidLabel = (bytes) => { const u = uuidStr(bytes); const n = gattName(u); return n ? `${u} (${n})` : u; };
const addrStr = (le) => Array.from(le).reverse().map((b) => b.toString(16).padStart(2, '0')).join(':').toUpperCase();
const hexOrEmpty = (b) => (b.length ? bytesToHex(b) : '(empty)');

function authStr(a) {
  const out = [['No Bonding', 'Bonding'][a & 0x3] || 'Reserved'];
  if (a & 0x04) out.push('MITM');
  if (a & 0x08) out.push('SC');
  if (a & 0x10) out.push('Keypress');
  if (a & 0x20) out.push('CT2');
  return out.join(' · ');
}
function keyDist(k) {
  const out = [];
  if (k & 0x01) out.push('EncKey');
  if (k & 0x02) out.push('IdKey');
  if (k & 0x04) out.push('Sign');
  if (k & 0x08) out.push('LinkKey');
  return out.join(', ') || 'none';
}

// ---- ATT ----
function decodeAtt(p) {
  const op = p[0];
  const name = attName(op);
  const r = new ByteReader(p); r.u8();
  const fields = [f('Opcode', `0x${hex2(op)} (${name})`)];
  let extra = '';
  const handleField = () => { const h = r.u16(); fields.push(f('Handle', handleStr(h))); return h; };
  switch (op) {
    case ATT_OP.ERROR_RSP: {
      const req = r.u8(), h = r.u16(), err = r.u8();
      fields.push(f('Request Opcode', `0x${hex2(req)} (${attName(req)})`), f('Handle', handleStr(h)), f('Error', `0x${hex2(err)} (${ATT_ERR_NAMES[err] || '?'})`));
      extra = `${attName(req)} → ${ATT_ERR_NAMES[err] || 'error'}`; break;
    }
    case ATT_OP.EXCHANGE_MTU_REQ: case ATT_OP.EXCHANGE_MTU_RSP: { const mtu = r.u16(); fields.push(f('MTU', mtu)); extra = `MTU ${mtu}`; break; }
    case ATT_OP.FIND_INFORMATION_REQ: { const s = r.u16(), e = r.u16(); fields.push(f('Start Handle', handleStr(s)), f('End Handle', handleStr(e))); extra = `0x${hex4(s)}..0x${hex4(e)}`; break; }
    case ATT_OP.READ_BY_TYPE_REQ: case ATT_OP.READ_BY_GROUP_TYPE_REQ: {
      const s = r.u16(), e = r.u16(), t = r.rest();
      fields.push(f('Start Handle', handleStr(s)), f('End Handle', handleStr(e)), f('Type', uuidLabel(t)));
      extra = `${uuidLabel(t)} · 0x${hex4(s)}..0x${hex4(e)}`; break;
    }
    case ATT_OP.READ_BY_GROUP_TYPE_RSP: {
      const len = r.u8(); fields.push(f('Item Length', len)); let n = 0;
      while (r.remaining >= len && len >= 4) { const a = r.u16(), b = r.u16(), v = r.read(len - 4); fields.push(f(`Group 0x${hex4(a)}–0x${hex4(b)}`, uuidLabel(v))); n++; }
      extra = `${n} group(s)`; break;
    }
    case ATT_OP.READ_BY_TYPE_RSP: {
      const len = r.u8(); fields.push(f('Item Length', len)); let n = 0;
      while (r.remaining >= len && len >= 2) { const a = r.u16(), v = r.read(len - 2); fields.push(f(`Handle 0x${hex4(a)}`, hexOrEmpty(v))); n++; }
      extra = `${n} item(s)`; break;
    }
    case ATT_OP.READ_REQ: { const h = handleField(); extra = `handle 0x${hex4(h)}`; break; }
    case ATT_OP.READ_BLOB_REQ: { const h = handleField(); const o = r.u16(); fields.push(f('Offset', o)); extra = `handle 0x${hex4(h)} @${o}`; break; }
    case ATT_OP.READ_RSP: case ATT_OP.READ_BLOB_RSP: { const v = r.rest(); fields.push(f('Value', hexOrEmpty(v))); extra = `${v.length} B`; break; }
    case ATT_OP.WRITE_REQ: case ATT_OP.WRITE_CMD: case ATT_OP.SIGNED_WRITE_CMD: { const h = handleField(); const v = r.rest(); fields.push(f('Value', hexOrEmpty(v))); extra = `handle 0x${hex4(h)}, ${v.length} B`; break; }
    case ATT_OP.HANDLE_VALUE_NTF: case ATT_OP.HANDLE_VALUE_IND: { const h = handleField(); const v = r.rest(); fields.push(f('Value', hexOrEmpty(v))); extra = `handle 0x${hex4(h)}, ${v.length} B`; break; }
    case ATT_OP.PREPARE_WRITE_REQ: case ATT_OP.PREPARE_WRITE_RSP: { const h = handleField(); const o = r.u16(); fields.push(f('Offset', o), f('Value', hexOrEmpty(r.rest()))); extra = `handle 0x${hex4(h)} @${o}`; break; }
    case ATT_OP.WRITE_RSP: case ATT_OP.HANDLE_VALUE_CFM: case ATT_OP.EXECUTE_WRITE_RSP: break;
    default: if (r.remaining) fields.push(f('Parameters', bytesToHex(r.rest())));
  }
  return { summary: `ATT ${name}${extra ? ' · ' + extra : ''}`, group: grp('ATT Protocol', fields) };
}

// ---- SMP ----
function decodeSmp(p) {
  const op = p[0];
  const name = SMP_OP_NAMES[op] || `Unknown 0x${hex2(op)}`;
  const r = new ByteReader(p); r.u8();
  const fields = [f('Opcode', `0x${hex2(op)} (${name})`)];
  let extra = '';
  switch (op) {
    case SMP_OP.PAIRING_REQUEST: case SMP_OP.PAIRING_RESPONSE: {
      const io = r.u8(), oob = r.u8(), auth = r.u8(), mks = r.u8(), ikd = r.u8(), rkd = r.u8();
      fields.push(f('IO Capability', `0x${hex2(io)} (${IO_NAMES[io] || '?'})`), f('OOB Data', oob ? 'present' : 'not present'), f('AuthReq', `0x${hex2(auth)} (${authStr(auth)})`), f('Max Encryption Key Size', mks), f('Initiator Key Distribution', keyDist(ikd)), f('Responder Key Distribution', keyDist(rkd)));
      extra = `${IO_NAMES[io] || '?'} · ${authStr(auth)}`; break;
    }
    case SMP_OP.PAIRING_CONFIRM: fields.push(f('Confirm Value', bytesToHex(r.rest()))); break;
    case SMP_OP.PAIRING_RANDOM: fields.push(f('Random Value', bytesToHex(r.rest()))); break;
    case SMP_OP.PAIRING_PUBLIC_KEY: fields.push(f('Public Key X', bytesToHex(r.read(32))), f('Public Key Y', bytesToHex(r.read(32)))); break;
    case SMP_OP.PAIRING_DHKEY_CHECK: fields.push(f('DHKey Check', bytesToHex(r.rest()))); break;
    case SMP_OP.PAIRING_FAILED: { const reason = r.u8(); fields.push(f('Reason', `0x${hex2(reason)} (${SMP_FAIL_NAMES[reason] || '?'})`)); extra = SMP_FAIL_NAMES[reason] || ''; break; }
    case SMP_OP.SECURITY_REQUEST: { const auth = r.u8(); fields.push(f('AuthReq', `0x${hex2(auth)} (${authStr(auth)})`)); extra = authStr(auth); break; }
    case SMP_OP.ENCRYPTION_INFORMATION: fields.push(f('Long Term Key', bytesToHex(r.rest()))); break;
    case SMP_OP.CENTRAL_IDENTIFICATION: { const ediv = r.u16(); fields.push(f('EDIV', `0x${hex4(ediv)}`), f('Rand', bytesToHex(r.rest()))); break; }
    case SMP_OP.IDENTITY_INFORMATION: fields.push(f('Identity Resolving Key', bytesToHex(r.rest()))); break;
    case SMP_OP.IDENTITY_ADDRESS_INFORMATION: { const t = r.u8(); fields.push(f('Address Type', t ? 'Random' : 'Public'), f('BD_ADDR', addrStr(r.rest()))); break; }
    case SMP_OP.SIGNING_INFORMATION: fields.push(f('Signature Key (CSRK)', bytesToHex(r.rest()))); break;
    case SMP_OP.KEYPRESS: fields.push(f('Notification Type', r.u8())); break;
    default: if (r.remaining) fields.push(f('Parameters', bytesToHex(r.rest())));
  }
  return { summary: `SMP ${name}${extra ? ' · ' + extra : ''}`, group: grp('SMP Protocol', fields) };
}

// ---- L2CAP signaling ----
function decodeSig(p) {
  const code = p[0], id = p[1], len = p[2] | (p[3] << 8), data = p.subarray(4, 4 + len);
  const name = SIG_NAMES[code] || `Unknown 0x${hex2(code)}`;
  const fields = [f('Code', `0x${hex2(code)} (${name})`), f('Identifier', id), f('Length', len)];
  let extra = '';
  if (code === 0x12) {
    const r = new ByteReader(data); const min = r.u16(), max = r.u16(), lat = r.u16(), to = r.u16();
    fields.push(f('Interval Min', `${min} (${(min * 1.25).toFixed(2)} ms)`), f('Interval Max', `${max} (${(max * 1.25).toFixed(2)} ms)`), f('Latency', lat), f('Timeout', `${to} (${to * 10} ms)`));
    extra = `${(min * 1.25).toFixed(1)}–${(max * 1.25).toFixed(1)} ms`;
  } else if (code === 0x13) { const res = data[0] | (data[1] << 8); fields.push(f('Result', res === 0 ? 'Accepted' : `Rejected (0x${hex4(res)})`)); extra = res === 0 ? 'accepted' : 'rejected'; }
  else if (data.length) fields.push(f('Data', bytesToHex(data)));
  return { summary: `L2CAP ${name}${extra ? ' · ' + extra : ''}`, group: grp('L2CAP Signaling', fields) };
}

function cidName(cid) {
  if (cid === L2CAP_CID.ATT) return 'ATT';
  if (cid === L2CAP_CID.SMP) return 'SMP';
  if (cid === L2CAP_CID.SIGNALING) return 'L2CAP Signaling';
  return `CID 0x${hex4(cid)}`;
}

/** Decode an H4 ACL data packet. Returns { summary, groups:[{name, fields:[{name,value}]}] }. */
export function decodeAcl(data) {
  const word = data[0] | (data[1] << 8);
  const handle = word & 0x0fff;
  const pb = (word >> 12) & 0x3;
  const bc = (word >> 14) & 0x3;
  const aclLen = data[2] | (data[3] << 8);
  const payload = data.subarray(4, 4 + aclLen);
  const aclGroup = grp('HCI ACL', [
    f('Connection Handle', handleStr(handle)),
    f('PB Flag', `0b${pb.toString(2).padStart(2, '0')} — ${PB_NAMES[pb]}`),
    f('BC Flag', `0b${bc.toString(2).padStart(2, '0')}`),
    f('Data Total Length', aclLen),
  ]);

  if (pb === 1) {
    return { summary: `ACL · L2CAP continuation · handle ${handle}, ${aclLen} B`, groups: [aclGroup, grp('L2CAP', [f('Note', 'continuation fragment — reassembled with the start packet')])] };
  }
  if (payload.length < 4) {
    return { summary: `ACL · handle ${handle}, ${aclLen} B`, groups: [aclGroup] };
  }

  const l2len = payload[0] | (payload[1] << 8);
  const cid = payload[2] | (payload[3] << 8);
  const l2payload = payload.subarray(4, 4 + l2len);
  const l2Group = grp('L2CAP', [f('Length', l2len), f('Channel ID', `0x${hex4(cid)} (${cidName(cid)})`)]);

  if (l2payload.length < l2len) {
    return { summary: `ACL · ${cidName(cid)} fragment (${l2payload.length}/${l2len} B) · handle ${handle}`, groups: [aclGroup, l2Group, grp(cidName(cid), [f('Note', `PDU fragmented across ACL packets (${l2payload.length} of ${l2len} bytes here)`)])] };
  }

  let proto;
  if (cid === L2CAP_CID.ATT) proto = decodeAtt(l2payload);
  else if (cid === L2CAP_CID.SMP) proto = decodeSmp(l2payload);
  else if (cid === L2CAP_CID.SIGNALING) proto = decodeSig(l2payload);
  else proto = { summary: `${cidName(cid)} · ${l2payload.length} B`, group: grp('L2CAP Payload', [f('Data', hexOrEmpty(l2payload))]) };

  // The connection handle lives in the detail tree; keep the one-liner Wireshark-Info-like.
  return { summary: `ACL · ${proto.summary}`, groups: [aclGroup, l2Group, proto.group] };
}
