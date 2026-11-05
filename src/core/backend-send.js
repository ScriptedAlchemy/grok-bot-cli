import { randomUUID } from "node:crypto";

// The Grok Bot gateway refuses /api/sendPrompt for box sessions ("A Sand box session is not
// permitted on this endpoint"). The desktop app sends through the Cursor backend instead.
// Only the few protobuf fields the app needs are encoded; no schema dependency.

const machineId = randomUUID();

function varint(value) {
  const out = [];
  let v = BigInt(value);
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

const str = (field, text) => {
  const bytes = new TextEncoder().encode(text);
  return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
};
const num = (field, value) => [...varint(field << 3), ...varint(value)];

export function encodeSendRequest({ agentId, prompt, clientNonce, sentAtMs = Date.now() }) {
  return Uint8Array.from([
    ...str(1, agentId),
    ...str(2, clientNonce),
    ...str(3, prompt),
    ...num(4, sentAtMs),
    ...num(13, 1), // source: DESKTOP
    ...str(16, machineId),
    ...str(20, "en"),
  ]);
}

export function decodeFields(buf) {
  const out = {};
  let i = 0;
  const next = () => {
    let v = 0n;
    let shift = 0n;
    let b;
    do {
      b = buf[i++] ?? 0;
      v |= BigInt(b & 0x7f) << shift;
      shift += 7n;
    } while (b & 0x80 && i < buf.length);
    return v;
  };
  while (i < buf.length) {
    const key = next();
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) out[field] = Number(next());
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else if (wire === 2) {
      const len = Number(next());
      out[field] = buf.slice(i, i + len);
      i += len;
    } else break;
  }
  return out;
}

/** Refusal message when the backend refused the message (delivery 4 or a refusal body), else null. */
export function refusalMessage(buf) {
  const data = decodeFields(buf);
  if (data[4] !== 4 && !data[5]) return null;
  const refusal = data[5] ? decodeFields(data[5]) : {};
  return refusal[2] ? new TextDecoder().decode(refusal[2]) : "refused";
}
