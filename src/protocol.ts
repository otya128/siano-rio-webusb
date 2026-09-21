// Ported from it9175_usb.c (c) 2015-2016 trinity19683. GPL-3.0-only.
export const MAX_TRANSFER = 64;
export const TS_TRANSFER_SIZE = 305 * 188;
export const Command = {
  read: 0x00,
  write: 0x01,
  cardRead: 0x04,
  cardWrite: 0x05,
  cardMode: 0x06,
  firmwareDownload: 0x21,
  firmwareQuery: 0x22,
  firmwareBoot: 0x23,
  firmwareScatter: 0x29,
} as const;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}
export function checksum(bytes: Uint8Array): number {
  let sum = 0;
  for (let i = 1; i < bytes.length - 2; i++)
    sum += i & 1 ? bytes[i] << 8 : bytes[i];
  return ~sum & 0xffff;
}
export function encodeRequest(
  command: number,
  mailbox: number,
  sequence: number,
  payload: Uint8Array,
): Uint8Array<ArrayBuffer> {
  if (payload.length > 58)
    throw new RangeError("USB command payload exceeds 58 bytes");
  const result = new Uint8Array(payload.length + 6);
  result.set([result.length - 1, mailbox, command, sequence]);
  result.set(payload, 4);
  const sum = checksum(result);
  result.set([sum >> 8, sum & 255], result.length - 2);
  return result;
}
export function decodeResponse(
  bytes: Uint8Array,
  sequence: number,
  length: number,
): Uint8Array {
  if (bytes.length !== length + 5 || bytes[0] !== bytes.length - 1)
    throw new ProtocolError("Invalid USB response length");
  if (
    checksum(bytes) !==
    ((bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1])
  )
    throw new ProtocolError("USB checksum mismatch");
  if (bytes[1] !== sequence)
    throw new ProtocolError("USB response sequence mismatch");
  if (bytes[2] !== 0)
    throw new ProtocolError(`Device status 0x${bytes[2].toString(16)}`);
  return bytes.slice(3, -2);
}

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
