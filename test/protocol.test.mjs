import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeMessage,
  decodeHeader,
  decodeMessage,
  u32le,
} from "../dist/protocol.js";
import { Msg, messageName } from "../dist/messages.js";
import {
  parseFirmware,
  downloadChunks,
  firmwareChecksum,
  reloadAddress,
} from "../dist/firmware.js";
import { parseVersion } from "../dist/core.js";
import { parseIsdbtStatistics } from "../dist/isdbt.js";
import { WebUsbTransport } from "../dist/transport.js";
import { FakeUsb, MSG, encode, firmwareImage } from "./fake-usb.mjs";

test("message header matches struct sms_msg_hdr layout", () => {
  const message = encodeMessage(
    Msg.MSG_SMS_ISDBT_TUNE_REQ,
    u32le(473143000, 8, 12000000, 0),
    201,
    11,
  );
  assert.deepEqual(
    [...message.subarray(0, 8)],
    [0x08, 0x03, 201, 11, 24, 0, 0, 0],
  );
  assert.deepEqual([...message.subarray(8, 12)], [0xd8, 0x96, 0x33, 0x1c]);
  assert.deepEqual(decodeHeader(message), {
    type: 776,
    src: 201,
    dst: 11,
    length: 24,
    flags: 0,
  });
  assert.equal(messageName(776), "MSG_SMS_ISDBT_TUNE_REQ");
  assert.equal(messageName(1), "Unknown msg type 1");
});
test("split messages are realigned by response_alignment and header flag bits", () => {
  const body = encode(MSG.INIT_DEVICE_RES, [1, 2, 3, 4]);
  const gap = 504 + 3;
  const transfer = new Uint8Array(gap + body.length + 5);
  transfer.set(body.subarray(0, 8));
  transfer[6] |= 4;
  transfer[7] = 3;
  transfer.set(body.subarray(8), gap + 8);
  assert.deepEqual([...decodeMessage(transfer, 504).payload], [1, 2, 3, 4]);
  // Without alignment info the flag is ignored, as for SMS_STELLAR.
  assert.deepEqual(decodeMessage(transfer, 0).payload.length, 4);
  // Short transfers and inconsistent lengths are dropped, not mis-parsed.
  assert.equal(decodeMessage(transfer.subarray(0, gap + 4), 504), undefined);
  assert.equal(decodeMessage(body.subarray(0, 10), 0), undefined);
  assert.equal(decodeMessage(new Uint8Array(3), 0), undefined);
  const extra = new Uint8Array(body.length + 100);
  extra.set(body);
  assert.deepEqual([...decodeMessage(extra, 504).payload], [1, 2, 3, 4]);
});
test("firmware image splits into 240-byte download chunks with running addresses", () => {
  const image = firmwareImage(1000, 0x40000);
  const firmware = parseFirmware(image);
  assert.equal(firmware.length, 1000);
  assert.equal(firmware.startAddress, 0x40000);
  assert.equal(firmware.checksum, firmwareChecksum(firmware));
  assert.equal(reloadAddress(firmware), 0x20000);
  const chunks = downloadChunks(firmware, firmware.startAddress);
  assert.deepEqual(
    chunks.map((c) => c.length - 4),
    [240, 240, 240, 240, 40],
  );
  const view = (c) => new DataView(c.buffer).getUint32(0, true);
  assert.deepEqual(
    chunks.map(view),
    [0x40000, 0x400f0, 0x401e0, 0x402d0, 0x403c0],
  );
  const joined = Buffer.concat(chunks.map((c) => c.subarray(4)));
  assert.deepEqual(joined, Buffer.from(image.subarray(12)));
  assert.throws(() => parseFirmware(image.subarray(0, 8)), /too short/);
  const lying = image.slice();
  new DataView(lying.buffer).setUint32(4, 5000, true);
  assert.throws(() => parseFirmware(lying), /exceeds/);
});
test("version and statistics responses decode field by field", () => {
  const res = new Uint8Array(48);
  new DataView(res.buffer).setUint16(0, 0x2270, true);
  res.set([1, 2, 255, 0, 3, 4, 5, 6, 8, 1, 0, 0], 2);
  res.set(new TextEncoder().encode("hello"), 14);
  assert.deepEqual(parseVersion(res), {
    chipModel: 0x2270,
    step: 1,
    metalFix: 2,
    firmwareId: 255,
    supportedProtocols: 0,
    firmwareVersion: "3.4.5.6",
    romVersion: "8.1.0.0",
    label: "hello",
  });
  const usb = new FakeUsb();
  const ex = parseIsdbtStatistics(
    usb.statisticsPayload(true).subarray(4),
    true,
  );
  assert.equal(ex.extended, true);
  assert.equal(ex.demodLocked, true);
  assert.equal(ex.snrDb, 25);
  assert.equal(ex.rssiDbm, -60);
  assert.equal(ex.inBandPowerDbm, -55);
  assert.equal(ex.frequencyHz, 629143000);
  assert.equal(ex.transmissionMode, 3);
  assert.equal(ex.guardIntervalDenominator, 8);
  assert.equal(ex.partialReception, true);
  assert.equal(ex.tuneBandwidth, 8);
  assert.equal(ex.layers.length, 3);
  assert.deepEqual(
    ex.layers.map((l) => [l.present, l.modulation, l.codeRate, l.segments]),
    [
      [true, "QPSK", "2/3", 1],
      [true, "64QAM", "3/4", 12],
      [false, "unknown", "unknown", 255],
    ],
  );
  assert.equal(ex.layers[2].ber, undefined);
  assert.equal(ex.layers[0].preBer, undefined);
  assert.equal(ex.layers[1].errorTsPackets, 0);
  assert.equal(ex.layers[0].berBitCount, 5000 * 204 * 8);
  assert.equal(ex.receptionQuality, 87);
  assert.equal(ex.lnaOn, true);
  assert.equal(ex.rfAgcLevel, 40000);
  assert.deepEqual(ex.firmwareErrorHistory, [1, 2, 3, 4, 0, 0, 0, 0]);
  assert.equal(ex.mrcSnrDb, -3);
  assert.equal(ex.snrFullResolutionDb, 26.5);
  const plain = parseIsdbtStatistics(usb.statisticsPayload(false), false);
  assert.equal(plain.extended, false);
  assert.equal(plain.tuneBandwidth, undefined);
  assert.equal(plain.receptionQuality, undefined);
  assert.equal(plain.layers[1].modulation, "64QAM");
  // Firmware 2.1 puts the strength where transmission_mode lives and reports nothing else.
  const old = usb.statisticsPayload(false);
  new DataView(old.buffer).setUint32(0, 0, true);
  new DataView(old.buffer).setInt32(11 * 4, -70, true);
  const legacy = parseIsdbtStatistics(old, false);
  assert.equal(legacy.inBandPowerDbm, -70);
  assert.equal(legacy.transmissionMode, 0);
  assert.equal(legacy.layers.length, 0);
  assert.throws(() => parseIsdbtStatistics(new Uint8Array(4), false), /Short/);
});
test("requests arm their waiter before sending and time out cleanly", async () => {
  const usb = new FakeUsb(),
    t = await WebUsbTransport.open(usb);
  const reply = await t.request(
    encodeMessage(Msg.MSG_SMS_INIT_DEVICE_REQ, u32le(6)),
    Msg.MSG_SMS_INIT_DEVICE_RES,
    100,
  );
  assert.equal(reply.type, Msg.MSG_SMS_INIT_DEVICE_RES);
  assert.deepEqual([...usb.sent.at(-1).payload], [6, 0, 0, 0]);
  await assert.rejects(
    t.request(
      encodeMessage(Msg.MSG_SMS_POWER_DOWN_REQ),
      Msg.MSG_SMS_POWER_DOWN_RES,
      20,
    ),
    /Timed out waiting for MSG_SMS_POWER_DOWN_RES/,
  );
  assert.equal(t.closed, false);
  // A late reply for a timed-out request is unsolicited and goes to onMessage.
  const unsolicited = [];
  t.onMessage = (m) => unsolicited.push(m.type);
  usb.respond(MSG.SIGNAL_DETECTED_IND);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(unsolicited, [MSG.SIGNAL_DETECTED_IND]);
  assert.deepEqual(usb.halts, [
    ["in", 1],
    ["out", 2],
  ]);
  await t.close();
  await t.close();
  assert.equal(usb.closeCount, 1);
  await assert.rejects(t.send(encodeMessage(1)), /closed/);
});
test("reads are processed in submission order across the queued transfers", async () => {
  const usb = new FakeUsb();
  const t = await WebUsbTransport.open(usb, { pendingReads: 4 });
  const seen = [];
  t.onMessage = (m) => seen.push(m.payload[0]);
  // More messages than reads in flight: the surplus waits in the device until reads are resubmitted.
  for (let i = 0; i < 25; i++) usb.emit(encode(MSG.INIT_DEVICE_RES, [i]));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, [...Array(25).keys()]);
  await t.close();
});
test("bulk OUT failures and repeated bad reads poison the session", async () => {
  const usb = new FakeUsb(),
    t = await WebUsbTransport.open(usb);
  const errors = [];
  t.onError = (e) => errors.push(e.message);
  usb.transferOut = async () => ({ status: "ok", bytesWritten: 0 });
  await assert.rejects(t.send(encodeMessage(1)), /short/);
  assert.equal(t.closed, true);
  assert.equal(usb.closeCount, 1);
  const bad = new FakeUsb();
  bad.transferIn = () => Promise.resolve({ status: "babble" });
  const t2 = await WebUsbTransport.open(bad);
  const failed = new Promise((resolve) => (t2.onError = resolve));
  assert.match((await failed).message, /repeatedly/);
  assert.equal(t2.closed, true);
  const timeout = new FakeUsb(),
    t3 = await WebUsbTransport.open(timeout, { timeoutMs: 15 });
  timeout.transferOut = () => new Promise(() => {});
  await assert.rejects(t3.send(encodeMessage(1)), /timed out/);
  assert.equal(t3.closed, true);
  const none = new FakeUsb();
  none.configurations = [];
  await assert.rejects(WebUsbTransport.open(none), /endpoints/);
  assert.equal(none.opened, false);
});
