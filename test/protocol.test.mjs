import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeRequest, decodeResponse } from "../dist/protocol.js";
import { WebUsbTransport } from "../dist/transport.js";
import { Registers } from "../dist/registers.js";
import { cardBlock, parseCardBlock } from "../dist/card.js";
import { FakeUsb } from "./fake-usb.mjs";

test("USB request matches hand-calculated register read vector", () => {
  assert.deepEqual(
    [...encodeRequest(0, 0, 0, Uint8Array.of(3, 2, 0, 0, 0x12, 0x22))],
    [0x0b, 0, 0, 0, 3, 2, 0, 0, 0x12, 0x22, 0xdb, 0xea],
  );
  assert.deepEqual(
    [...decodeResponse(Uint8Array.of(5, 7, 0, 0xab, 0x4d, 0xff), 7, 1)],
    [0xab],
  );
});
test("response framing, sequence, length, checksum and status are checked", () => {
  const valid = Uint8Array.of(4, 0, 0, 0xff, 0xff);
  assert.equal(decodeResponse(valid, 0, 0).length, 0);
  for (const index of [0, 1, 2, 3, 4]) {
    const damaged = valid.slice();
    damaged[index] ^= 1;
    assert.throws(() => decodeResponse(damaged, 0, 0));
  }
  assert.throws(() => decodeResponse(valid, 1, 0));
  assert.throws(
    () => decodeResponse(Uint8Array.of(4, 0, 1, 0xff, 0xfe), 0, 0),
    /status/,
  );
});
test("concurrent register commands serialize and sequence wraps", async () => {
  const usb = new FakeUsb(),
    transport = await WebUsbTransport.open(usb),
    r = new Registers(transport);
  const results = await Promise.all(
    Array.from({ length: 260 }, () => r.read(0x1222, 3)),
  );
  for (const result of results) assert.deepEqual([...result], [1, 0x75, 0x91]);
  assert.equal(usb.commands[256][3], 0);
  await transport.close();
});
test("mailbox and limits, including original unsafe APDU boundary", async () => {
  const usb = new FakeUsb(),
    t = await WebUsbTransport.open(usb),
    r = new Registers(t);
  await r.write(0x80abcd, [4, 5]);
  assert.deepEqual(
    [...usb.commands[0].subarray(1, -2)],
    [0x80, 1, 0, 2, 2, 0, 0, 0xab, 0xcd, 4, 5],
  );
  await assert.rejects(r.write(0, new Uint8Array(53)), /1–52/);
  assert.throws(() => r.read(0, 60), /1–59/);
  await assert.rejects(t.command(1, 0, new Uint8Array(59)), /58/);
  const block = cardBlock(0x40, Uint8Array.of(0, 0xa4));
  assert.deepEqual([...block], [0, 0x40, 2, 0, 0xa4, 0xe6]);
  assert.deepEqual([...parseCardBlock(block).data], [0, 0xa4]);
  block[5] ^= 1;
  assert.throws(() => parseCardBlock(block), /LRC/);
  await t.close();
});
test("short write poisons session and queued commands never touch USB", async () => {
  const usb = new FakeUsb(),
    t = await WebUsbTransport.open(usb);
  usb.transferOut = async () => ({ status: "ok", bytesWritten: 0 });
  await assert.rejects(t.command(0), /short/);
  await assert.rejects(t.command(0), /closed/);
  assert.equal(usb.closeCount, 1);
});
test("timeout closes session without allowing a late transfer to start a new exchange", async () => {
  const usb = new FakeUsb(),
    t = await WebUsbTransport.open(usb, 15);
  usb.transferIn = () => new Promise(() => {});
  const first = t.command(0),
    second = t.command(0);
  await assert.rejects(first, /timed out/);
  await assert.rejects(second, /closed/);
  assert.equal(usb.commands.length, 1);
  assert.equal(usb.closeCount, 1);
});
test("setup failure releases device", async () => {
  const usb = new FakeUsb();
  usb.configurations = [];
  await assert.rejects(WebUsbTransport.open(usb), /endpoints/);
  assert.equal(usb.opened, false);
});
