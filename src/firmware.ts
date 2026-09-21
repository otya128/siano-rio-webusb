// Firmware image handling from smscore_load_firmware_family2() (Siano Mobile Silicon). GPL-2.0-or-later.
import { SMS_MAX_PAYLOAD_SIZE } from "./messages.js";
import { u32le } from "./protocol.js";

/** struct sms_firmware: the on-disk layout of *.inp files such as isdbt_rio.inp. */
export interface FirmwareImage {
  checksum: number;
  length: number;
  startAddress: number;
  payload: Uint8Array;
}
export const FIRMWARE_HEADER_SIZE = 12;
export function parseFirmware(image: Uint8Array): FirmwareImage {
  if (image.length < FIRMWARE_HEADER_SIZE)
    throw new Error("Firmware image is too short");
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const firmware = {
    checksum: view.getUint32(0, true),
    length: view.getUint32(4, true),
    startAddress: view.getUint32(8, true),
    payload: image.subarray(FIRMWARE_HEADER_SIZE),
  };
  if (firmware.length === 0 || firmware.length > firmware.payload.length)
    throw new Error("Firmware length field exceeds the image");
  return firmware;
}
/** Sum of the payload words, as the kernel computes for its debug print of MSG_SMS_DATA_VALIDITY_REQ. */
export function firmwareChecksum(firmware: FirmwareImage): number {
  const view = new DataView(
    firmware.payload.buffer,
    firmware.payload.byteOffset,
    firmware.payload.byteLength,
  );
  let sum = 0;
  for (let i = 0; i + 4 <= firmware.length; i += 4)
    sum = (sum + view.getUint32(i, true)) >>> 0;
  return sum;
}
/** When firmware is already running, the reload address comes from the image itself (payload[20]). */
export function reloadAddress(firmware: FirmwareImage): number {
  if (firmware.payload.length < 24)
    throw new Error("Firmware image has no reload address");
  return new DataView(
    firmware.payload.buffer,
    firmware.payload.byteOffset,
    firmware.payload.byteLength,
  ).getUint32(20, true);
}
/** struct sms_data_download payloads: u32 mem_addr followed by up to SMS_MAX_PAYLOAD_SIZE bytes. */
export function downloadChunks(
  firmware: FirmwareImage,
  memAddress: number,
): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < firmware.length;) {
    const size = Math.min(firmware.length - offset, SMS_MAX_PAYLOAD_SIZE);
    const chunk = new Uint8Array(4 + size);
    chunk.set(u32le(memAddress + offset));
    chunk.set(firmware.payload.subarray(offset, offset + size), 4);
    chunks.push(chunk);
    offset += size;
  }
  return chunks;
}
