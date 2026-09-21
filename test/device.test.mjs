import { test } from "node:test";
import assert from "node:assert/strict";
import { Fsusb2i, channelFrequency, TsPacketFramer } from "../dist/index.js";
import { firmwarePackets } from "../dist/firmware.js";
import { firmware } from "../dist/firmware-data.js";
import { FakeUsb, packets } from "./fake-usb.mjs";

test("scatter firmware preserves every source bank/address/data byte", () => {
  const expected = new Map();
  let offset = 0;
  do {
    const bank = firmware[offset++];
    while (true) {
      const length = firmware[offset++] * 256 + firmware[offset++];
      if (!length) break;
      const address = firmware[offset++] * 256 + firmware[offset++];
      for (let i = 0; i < length; i++)
        expected.set(bank * 65536 + address + i, firmware[offset++]);
    }
  } while (firmware[offset]);
  const actual = new Map();
  for (const packet of firmwarePackets(firmware)) {
    assert.ok(packet.length <= 48);
    assert.equal(packet[0], 3);
    const count = packet[3];
    assert.ok(count > 0 && count <= 3);
    let p = 4 + count * 3;
    for (let i = count - 1; i >= 0; i--) {
      const address = packet[4 + i * 3] * 256 + packet[5 + i * 3],
        length = packet[6 + i * 3];
      for (let j = 0; j < length; j++)
        actual.set(packet[1] * 65536 + address + j, packet[p++]);
    }
    assert.equal(p, packet.length);
  }
  assert.deepEqual(actual, expected);
  for (const bytes of [
    new Uint8Array(),
    firmware.slice(0, -1),
    Uint8Array.of(0, 0, 0, 0),
  ])
    assert.throws(() => firmwarePackets(bytes));
});
test("warm initialization, channel 39 tuning, statistics, TMCC and clean close", async () => {
  const usb = new FakeUsb(),
    dev = await Fsusb2i.open(usb);
  assert.equal(dev.info.chipId, 0x91758301);
  assert.equal(dev.info.firmwareVersion, 0x04030201);
  assert.equal(
    usb.commands.some((c) => c[2] === 0x29),
    false,
  );
  assert.equal(usb.registers.get(0xdd88), 0xff);
  assert.equal(usb.registers.get(0xdd89), 0x37);
  assert.equal(usb.registers.get(0x80f996), 0xff);
  assert.equal(usb.registers.get(0x80f997), 0x1f);
  assert.equal(channelFrequency(39), 629143);
  await dev.setChannel(39);
  // Calibrated N-divider=6, index=6, fdiv=3, xtal=2000. Frequency register must retain index bits.
  const lo = Math.floor((629143 * 18) / 2000 + 0.5) | (6 << 13);
  assert.equal(usb.registers.get(0x80015e), lo & 255);
  assert.equal(usb.registers.get(0x80015f), (lo >>> 8) & 255);
  assert.equal(
    usb.registers.get(0x8001e2),
    (((4 << 13) | (lo & 8191)) >>> 8) & 255,
  );
  usb.registers.set(0x800047, 1);
  assert.equal((await dev.waitTuning()).status, "locked");
  usb.registers.set(0x80f999, 1);
  usb.registers.set(0x80f980, 1);
  assert.equal((await dev.waitStream()).overflow, true);
  assert.equal(usb.registers.get(0x80f980), 0);
  usb.registers.set(0x80013f, 42);
  assert.equal((await dev.readStatistics()).strengthDbm, -58);
  usb.registers.set(0x80f900, 1);
  assert.equal((await dev.readTmcc()).mode, 3);
  usb.registers.set(0x80004c, 0);
  // Emulate firmware clearing the sleep handshake written by the driver.
  const original = usb.transferOut.bind(usb);
  usb.transferOut = async (...args) => {
    const result = await original(...args);
    usb.registers.set(0x80004c, 0);
    return result;
  };
  await dev.close();
  await dev.close();
  assert.equal(usb.closeCount, 1);
  await assert.rejects(dev.readStatistics(), /closed/);
});
test("cold initialization downloads firmware and rejects unsupported hardware", async () => {
  const usb = new FakeUsb();
  usb.firmwareLoaded = false;
  const dev = await Fsusb2i.open(usb);
  assert.equal(
    usb.commands.filter((c) => c[2] === 0x29).length,
    firmwarePackets(firmware).length,
  );
  await dev.close();
  const bad = new FakeUsb();
  bad.registers.set(0x1222, 2);
  await assert.rejects(Fsusb2i.open(bad), /Unsupported chip/);
  assert.equal(bad.opened, false);
});
test("card reset/IFS and concurrent APDUs preserve alternating sequence", async () => {
  const usb = new FakeUsb(),
    dev = await Fsusb2i.open(usb);
  assert.deepEqual([...(await dev.resetCard())], [0x3b, 0]);
  const result = await Promise.all([
    dev.transmitCard(Uint8Array.of(0, 0xa4)),
    dev.transmitCard(Uint8Array.of(0, 0xb0)),
  ]);
  assert.deepEqual(
    result.map((b) => [...b]),
    [
      [0x90, 0],
      [0x90, 0],
    ],
  );
  assert.deepEqual(
    usb.commands.filter((c) => c[2] === 5).map((c) => c[6]),
    [0xc1, 0, 0x40],
  );
  await assert.rejects(dev.transmitCard(new Uint8Array(54)), /1–53/);
  usb.registers.set(0x80fba5, 1);
  await assert.rejects(dev.transmitCard(Uint8Array.of(0)), /not present/);
  assert.equal(dev.atr.length, 0);
  await dev.close();
});
test("TS framing survives every split point and recovers from inserted garbage", () => {
  const input = packets(5);
  for (let split = 0; split < input.length; split++) {
    const framer = new TsPacketFramer();
    const a = framer.push(input.subarray(0, split)),
      b = framer.push(input.subarray(split));
    assert.deepEqual(Buffer.concat([a, b]), Buffer.from(input));
  }
  const framer = new TsPacketFramer();
  const dirty = Uint8Array.from([1, 2, 3, ...input, 8, 9, ...input]);
  assert.deepEqual(framer.push(dirty), Uint8Array.from([...input, ...input]));
  assert.equal(framer.droppedBytes, 5);
});
test("aborting a pending TS read closes it promptly, ending the iterator", async () => {
  const usb = new FakeUsb(),
    dev = await Fsusb2i.open(usb),
    abort = new AbortController();
  const stream = dev.stream({ signal: abort.signal });
  const read = stream.next();
  await new Promise((resolve) => setTimeout(resolve, 10));
  abort.abort();
  assert.equal((await read).done, true);
  assert.equal(dev.closed, true);
  assert.equal(usb.closeCount, 1);
});
test("stream rejects a second consumer, disallows tuning, closes on iterator return", async () => {
  const usb = new FakeUsb(),
    dev = await Fsusb2i.open(usb);
  usb.tsChunks.push(packets(5));
  const stream = dev.stream();
  assert.equal((await stream.next()).value.length, 940);
  await assert.rejects(dev.stream().next(), /one TS consumer/);
  await assert.rejects(dev.setChannel(13), /retuning/);
  await stream.return();
  assert.equal(dev.closed, true);
});

test("all initialization and tuning register writes match original C on three clock modes", async () => {
  const { readFile } = await import("node:fs/promises");
  const traces = JSON.parse(
    await readFile(
      new URL("./fixtures/c-tuning-traces.json", import.meta.url),
      "utf8",
    ),
  );
  for (const { mode, frequencies, writes } of traces) {
    const usb = new FakeUsb();
    usb.registers.set(0x80ec86, mode);
    const dev = await Fsusb2i.open(usb);
    for (const frequency of frequencies) {
      usb.registers.set(0x8001c6, 1);
      await dev.setFrequency(frequency);
    }
    assert.deepEqual(
      usb.writes,
      writes,
      `C trace differs for clock mode ${mode}`,
    );
    await dev.close();
  }
});
