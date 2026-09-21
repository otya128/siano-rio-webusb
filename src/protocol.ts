// Message framing ported from smscoreapi.h / smsusb.c / smsendian.c (Siano Mobile Silicon). GPL-2.0-or-later.
import { HIF_TASK, MSG_HDR_FLAG_SPLIT_MSG, messageName } from "./messages.js";

/** struct sms_msg_hdr: msg_type u16, msg_src_id u8, msg_dst_id u8, msg_length u16 (whole message), msg_flags u16. All little-endian. */
export const HEADER_SIZE = 8;
/** USB2_BUFFER_SIZE: every bulk IN read carries at most one message of this size. */
export const USB_BUFFER_SIZE = 0x2000;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}
export interface MessageHeader {
  type: number;
  src: number;
  dst: number;
  length: number;
  flags: number;
}
export interface Message extends MessageHeader {
  /** Bytes following the header (after split-message realignment). */
  payload: Uint8Array;
}
export const u32le = (...values: number[]): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, i) => view.setUint32(i * 4, value >>> 0, true));
  return bytes;
};
/** SMS_INIT_MSG_EX(): build a complete message; msg_length counts the header. */
export function encodeMessage(
  type: number,
  payload: Uint8Array | ArrayLike<number> = new Uint8Array(0),
  src = 0,
  dst = HIF_TASK,
  flags = 0,
): Uint8Array<ArrayBuffer> {
  const data = Uint8Array.from(payload);
  if (data.length + HEADER_SIZE > 0xffff)
    throw new RangeError("Message exceeds 65535 bytes");
  const message = new Uint8Array(HEADER_SIZE + data.length);
  const view = new DataView(message.buffer);
  view.setUint16(0, type, true);
  message[2] = src;
  message[3] = dst;
  view.setUint16(4, message.length, true);
  view.setUint16(6, flags, true);
  message.set(data, HEADER_SIZE);
  return message;
}
export function decodeHeader(bytes: Uint8Array): MessageHeader {
  if (bytes.length < HEADER_SIZE)
    throw new ProtocolError("Short message header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    type: view.getUint16(0, true),
    src: bytes[2],
    dst: bytes[3],
    length: view.getUint16(4, true),
    flags: view.getUint16(6, true),
  };
}
/**
 * smsusb_onresponse(): one bulk IN transfer holds one message. With
 * MSG_HDR_FLAG_SPLIT_MSG the firmware left a gap after the header so the
 * payload begins at responseAlignment + ((flags >> 8) & 3) + HEADER_SIZE.
 * Returns undefined for a transfer the kernel would log and drop.
 */
export function decodeMessage(
  bytes: Uint8Array,
  responseAlignment: number,
): Message | undefined {
  if (bytes.length < HEADER_SIZE) return undefined;
  const header = decodeHeader(bytes);
  if (header.length < HEADER_SIZE || bytes.length < header.length)
    return undefined;
  let offset = 0;
  if (responseAlignment && header.flags & MSG_HDR_FLAG_SPLIT_MSG) {
    offset = responseAlignment + ((header.flags >> 8) & 3);
    if (header.length + offset > bytes.length) return undefined;
  }
  return {
    ...header,
    payload: bytes.slice(offset + HEADER_SIZE, offset + header.length),
  };
}
export const describeMessage = (header: MessageHeader): string =>
  `${messageName(header.type)}(${header.type}) size: ${header.length}`;

/** Each submitted operation runs to completion before the next starts. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
