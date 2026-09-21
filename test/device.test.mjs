import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SianoRio,
  channelFrequency,
  TsPacketFramer,
  PID_ALL,
  Msg,
  DeviceMode,
} from "../dist/index.js";
import { FakeUsb, MSG, firmwareImage, packets } from "./fake-usb.mjs";

const types = (usb) => usb.sent.map((m) => m.type);

test("warm start: version query, INIT_DEVICE, tune, statistics and close", async () => {
  const usb = new FakeUsb(),
    dev = await SianoRio.open(usb);
  assert.equal(dev.info.chipModel, 0x2270);
  assert.equal(dev.info.firmwareId, DeviceMode.ISDBT_BDA);
  assert.equal(dev.info.mode, DeviceMode.ISDBT_BDA);
  assert.equal(dev.info.label, "SMS2270 Rio");
  assert.equal(dev.info.firmwareDownloaded, false);
  // Firmware already serves ISDBT_BDA: smscore_set_device_mode() returns before any INIT_DEVICE.
  assert.deepEqual(types(usb), [Msg.MSG_SMS_GET_VERSION_EX_REQ]);
  assert.equal(usb.sent[0].dst, 11);
  assert.equal(channelFrequency(39), 629143);
  await dev.tuneChannel(39);
  assert.deepEqual(usb.tunes, [[629143000, 8, 12000000, 0]]);
  await dev.tuneChannel(13, { bandwidth: "1seg" });
  await dev.tune(473143, { bandwidth: "3seg", segmentIndex: 2 });
  assert.deepEqual(usb.tunes.slice(1), [
    [473143000, 4, 12000000, 0],
    [473143000, 5, 12000000, 2],
  ]);
  const tune = usb.sent.find((m) => m.type === Msg.MSG_SMS_ISDBT_TUNE_REQ);
  assert.equal(tune.src, 201);
  assert.equal(tune.dst, 11);
  await assert.rejects(dev.tune(1000), /Hz/);
  await assert.rejects(dev.tuneChannel(63), /13–62/);
  const stats = await dev.readStatistics();
  assert.equal(stats.extended, true); // rom 8.1 >= 0x800 selects GET_STATISTICS_EX
  assert.equal(stats.demodLocked, true);
  assert.equal(dev.status, "locked");
  assert.equal(usb.sent.at(-1).type, Msg.MSG_SMS_GET_STATISTICS_EX_REQ);
  // Rate limited: a second read within 100 ms returns the cached statistics.
  assert.equal(await dev.readStatistics(), stats);
  assert.equal(usb.sent.at(-1).type, Msg.MSG_SMS_GET_STATISTICS_EX_REQ);
  usb.stats.demodLocked = 0;
  usb.stats.rfLocked = 1;
  await new Promise((r) => setTimeout(r, 110));
  assert.equal((await dev.readStatistics()).demodLocked, false);
  assert.equal(dev.status, "signal");
  await dev.close();
  await dev.close();
  assert.equal(usb.closeCount, 1);
  await assert.rejects(dev.readStatistics(), /closed/);
});
test("old ROMs use MSG_SMS_GET_STATISTICS_REQ and indications update the status", async () => {
  const usb = new FakeUsb();
  usb.romVersion = [2, 1, 0, 0];
  const dev = await SianoRio.open(usb);
  const stats = await dev.readStatistics();
  assert.equal(stats.extended, false);
  assert.equal(usb.sent.at(-1).type, Msg.MSG_SMS_GET_STATISTICS_REQ);
  usb.respond(MSG.NO_SIGNAL_IND);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(dev.status, "no-signal");
  usb.respond(MSG.SIGNAL_DETECTED_IND);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(dev.status, "locked");
  await dev.close();
});
test("cold start downloads the firmware exactly as smscore_load_firmware_family2()", async () => {
  const usb = new FakeUsb();
  usb.firmwareId = 255;
  const image = firmwareImage(700, 0x40000);
  await assert.rejects(SianoRio.open(usb), /needs a firmware image/);
  assert.equal(usb.opened, false);
  const cold = new FakeUsb();
  cold.firmwareId = 255;
  const dev = await SianoRio.open(cold, { firmware: image });
  assert.equal(dev.info.firmwareDownloaded, true);
  assert.equal(dev.info.firmwareId, 6);
  const sequence = types(cold);
  assert.deepEqual(sequence, [
    Msg.MSG_SMS_GET_VERSION_EX_REQ,
    Msg.MSG_SMS_DATA_DOWNLOAD_REQ,
    Msg.MSG_SMS_DATA_DOWNLOAD_REQ,
    Msg.MSG_SMS_DATA_DOWNLOAD_REQ,
    Msg.MSG_SMS_DATA_VALIDITY_REQ,
    Msg.MSG_SMS_SWDOWNLOAD_TRIGGER_REQ,
    Msg.MSG_SMS_INIT_DEVICE_REQ,
    Msg.MSG_SMS_INIT_DEVICE_REQ,
    Msg.MSG_SMS_GET_VERSION_EX_REQ,
  ]);
  const loaded = Array.from({ length: 700 }, (_, i) =>
    cold.memory.get(0x40000 + i),
  );
  assert.deepEqual(loaded, [...image.subarray(12)]);
  const validity = cold.sent.find(
    (m) => m.type === Msg.MSG_SMS_DATA_VALIDITY_REQ,
  );
  const view = new DataView(
    validity.payload.buffer,
    validity.payload.byteOffset,
  );
  assert.deepEqual(
    [view.getUint32(0, true), view.getUint32(4, true), view.getUint32(8, true)],
    [0x40000, 700, 0],
  );
  const trigger = cold.sent.find(
    (m) => m.type === Msg.MSG_SMS_SWDOWNLOAD_TRIGGER_REQ,
  );
  const tv = new DataView(trigger.payload.buffer, trigger.payload.byteOffset);
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((i) => tv.getUint32(i * 4, true)),
    [0x40000, 6, 0x200, 0, 4],
  );
  const init = cold.sent.find((m) => m.type === Msg.MSG_SMS_INIT_DEVICE_REQ);
  assert.deepEqual([...init.payload], [6, 0, 0, 0]);
  await dev.close();
});
test("switching modes on running firmware reloads through SW_RELOAD_START/EXEC", async () => {
  const usb = new FakeUsb();
  usb.firmwareId = DeviceMode.DVBT_BDA;
  const image = firmwareImage(300, 0x40000);
  const dev = await SianoRio.open(usb, { firmware: image });
  assert.deepEqual(types(usb).slice(0, 5), [
    Msg.MSG_SMS_GET_VERSION_EX_REQ,
    Msg.MSG_SW_RELOAD_START_REQ,
    Msg.MSG_SMS_DATA_DOWNLOAD_REQ,
    Msg.MSG_SMS_DATA_DOWNLOAD_REQ,
    Msg.MSG_SMS_DATA_VALIDITY_REQ,
  ]);
  assert.equal(types(usb)[5], Msg.MSG_SW_RELOAD_EXEC_REQ);
  // Reload writes to the address stored at payload[20], not the image start address.
  assert.equal(usb.memory.get(0x20000), image[12]);
  assert.equal(usb.memory.has(0x40000), false);
  assert.equal(dev.info.mode, DeviceMode.ISDBT_BDA);
  await dev.close();
  const other = new FakeUsb();
  await assert.rejects(
    SianoRio.open(other, { mode: DeviceMode.DVBT_BDA, firmware: image }),
    /not ISDB-T/,
  );
  assert.equal(other.opened, false);
});
test("split responses are accepted through the transport", async () => {
  const usb = new FakeUsb();
  usb.splitResponses = true;
  const dev = await SianoRio.open(usb);
  assert.equal(dev.info.label, "SMS2270 Rio");
  assert.equal((await dev.readStatistics()).snrDb, 25);
  await dev.close();
});
test("stream adds the PID filter, yields aligned TS and removes the filter when done", async () => {
  const usb = new FakeUsb(),
    dev = await SianoRio.open(usb);
  const input = packets(300);
  // Arbitrary chunking, as the firmware does not align MSG_SMS_DVBT_BDA_DATA to 188 bytes.
  usb.tsChunks.push(
    input.subarray(0, 1000),
    input.subarray(1000, 20000),
    input.subarray(20000),
  );
  const stream = dev.stream();
  const first = await stream.next();
  assert.equal(usb.sent.at(-1).type, Msg.MSG_SMS_ADD_PID_FILTER_REQ);
  assert.deepEqual([...usb.pidFilters], [PID_ALL]);
  assert.deepEqual(dev.pidFilters, [PID_ALL]);
  const received = [first.value];
  while (received.reduce((n, c) => n + c.length, 0) < input.length)
    received.push((await stream.next()).value);
  assert.deepEqual(Buffer.concat(received), Buffer.from(input));
  await assert.rejects(dev.stream().next(), /one TS consumer/);
  // Tuning while streaming is allowed, as with a DVB frontend.
  await dev.tuneChannel(20);
  await stream.return();
  assert.equal(usb.sent.at(-1).type, Msg.MSG_SMS_REMOVE_PID_FILTER_REQ);
  assert.equal(usb.pidFilters.size, 0);
  assert.equal(dev.closed, false);
  // A second stream with explicit PIDs works on the same session.
  usb.tsChunks.push(packets(3));
  const second = dev.stream({ pids: [0, 0x1fc8] });
  assert.equal((await second.next()).value.length, 564);
  assert.deepEqual([...usb.pidFilters], [0, 0x1fc8]);
  await second.return();
  await dev.close();
});
test("aborting a waiting stream ends it promptly and keeps the device usable", async () => {
  const usb = new FakeUsb(),
    dev = await SianoRio.open(usb),
    abort = new AbortController();
  const stream = dev.stream({ signal: abort.signal });
  const read = stream.next();
  await new Promise((resolve) => setTimeout(resolve, 10));
  abort.abort();
  assert.equal((await read).done, true);
  assert.equal(dev.closed, false);
  assert.equal(usb.pidFilters.size, 0);
  assert.equal((await dev.readStatistics()).rfLocked, true);
  // Closing while a stream waits ends the stream and removes filters before the USB handle goes.
  const stream2 = dev.stream();
  const read2 = stream2.next();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await dev.close();
  assert.equal((await read2).done, true);
  assert.equal(usb.pidFilters.size, 0);
  assert.equal(usb.closeCount, 1);
});
test("a slow consumer loses the oldest data instead of stalling the control channel", async () => {
  const usb = new FakeUsb(),
    dev = await SianoRio.open(usb);
  const stream = dev.stream({ maxQueuedBytes: 188 * 10 });
  // Prime a waiting consumer, then flood the device while it is not pulling.
  const pending = stream.next();
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (let i = 0; i < 20; i++) usb.tsChunks.push(packets(1));
  usb.flushTs();
  // The framer needs three sync bytes before it emits, so the first chunk merges a few packets.
  assert.equal((await pending).value.length % 188, 0);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(dev.droppedBytes >= 188 * 6, `dropped ${dev.droppedBytes}`);
  assert.ok(dev.droppedBytes % 188 === 0);
  // Control traffic still flows while the queue is saturated.
  assert.equal((await dev.readStatistics()).demodLocked, true);
  await stream.return();
  await dev.close();
});
test("a reader failure surfaces through the stream and closes the device", async () => {
  const usb = new FakeUsb(),
    dev = await SianoRio.open(usb);
  const stream = dev.stream();
  const read = stream.next();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const reader = usb.readers.shift();
  reader.reject(new Error("device gone"));
  await assert.rejects(read, /device gone/);
  assert.equal(dev.closed, true);
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
