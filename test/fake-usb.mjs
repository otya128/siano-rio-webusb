/** In-memory Siano Rio (SMS2270) behaving like the firmware paths smsusb.c/smscoreapi.c exercise. */
const HEADER = 8;
const M = {
  GET_VERSION_EX_REQ: 668,
  GET_VERSION_EX_RES: 669,
  SW_RELOAD_START_REQ: 702,
  SW_RELOAD_START_RES: 703,
  SW_RELOAD_EXEC_REQ: 704,
  DATA_DOWNLOAD_REQ: 660,
  DATA_DOWNLOAD_RES: 661,
  DATA_VALIDITY_REQ: 662,
  DATA_VALIDITY_RES: 663,
  SWDOWNLOAD_TRIGGER_REQ: 664,
  SWDOWNLOAD_TRIGGER_RES: 665,
  INIT_DEVICE_REQ: 578,
  INIT_DEVICE_RES: 579,
  ISDBT_TUNE_REQ: 776,
  ISDBT_TUNE_RES: 777,
  ADD_PID_FILTER_REQ: 601,
  ADD_PID_FILTER_RES: 602,
  REMOVE_PID_FILTER_REQ: 603,
  REMOVE_PID_FILTER_RES: 604,
  GET_STATISTICS_REQ: 615,
  GET_STATISTICS_RES: 616,
  GET_STATISTICS_EX_REQ: 653,
  GET_STATISTICS_EX_RES: 654,
  DVBT_BDA_DATA: 693,
  SIGNAL_DETECTED_IND: 827,
  NO_SIGNAL_IND: 828,
  SET_MAX_TX_MSG_LEN_REQ: 516,
  NEW_CRYSTAL_REQ: 794,
};
export const MSG = M;
export function decode(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    type: view.getUint16(0, true),
    src: bytes[2],
    dst: bytes[3],
    length: view.getUint16(4, true),
    flags: view.getUint16(6, true),
    payload: bytes.slice(HEADER, view.getUint16(4, true)),
  };
}
export function encode(
  type,
  payload = [],
  { src = 11, dst = 0, flags = 0 } = {},
) {
  const data = Uint8Array.from(payload);
  const message = new Uint8Array(HEADER + data.length);
  const view = new DataView(message.buffer);
  view.setUint16(0, type, true);
  message[2] = src;
  message[3] = dst;
  view.setUint16(4, message.length, true);
  view.setUint16(6, flags, true);
  message.set(data, HEADER);
  return message;
}
export const words = (...values) => {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((v, i) => view.setUint32(i * 4, v >>> 0, true));
  return bytes;
};
const word = (bytes, i) =>
  new DataView(bytes.buffer, bytes.byteOffset).getUint32(i * 4, true);
/** A tiny *.inp: checksum, length, start address, then payload. */
export function firmwareImage(length = 1000, startAddress = 0x40000) {
  const payload = Uint8Array.from({ length }, (_, i) => (i * 7 + 3) & 255);
  const view = new DataView(payload.buffer);
  view.setUint32(20, 0x20000, true); // reload address
  let sum = 0;
  for (let i = 0; i + 4 <= length; i += 4)
    sum = (sum + view.getUint32(i, true)) >>> 0;
  const image = new Uint8Array(12 + length);
  new DataView(image.buffer).setUint32(0, sum, true);
  new DataView(image.buffer).setUint32(4, length, true);
  new DataView(image.buffer).setUint32(8, startAddress, true);
  image.set(payload, 12);
  return image;
}
export class FakeUsb {
  opened = false;
  vendorId = 0x3275;
  productId = 0x0080;
  productName = "PX-S1UD";
  configurations = [
    {
      configurationValue: 1,
      interfaces: [
        {
          interfaceNumber: 0,
          alternates: [
            {
              alternateSetting: 0,
              endpoints: [
                {
                  endpointNumber: 1,
                  direction: "in",
                  type: "bulk",
                  packetSize: 512,
                },
                {
                  endpointNumber: 2,
                  direction: "out",
                  type: "bulk",
                  packetSize: 512,
                },
              ],
            },
          ],
        },
      ],
    },
  ];
  configuration = null;
  /** 255 = ROM (cold); 6 = ISDBT_BDA firmware running. */
  firmwareId = 6;
  romVersion = [8, 1, 0, 0];
  chipModel = 0x2270;
  memory = new Map();
  sent = [];
  outbox = [];
  readers = [];
  pidFilters = new Set();
  tsChunks = [];
  tunes = [];
  closeCount = 0;
  halts = [];
  /** Emit responses with MSG_HDR_FLAG_SPLIT_MSG and a gap of responseAlignment + n. */
  splitResponses = false;
  /** Statistics fields, in sms_isdbt_stats_ex order. */
  stats = {
    rfLocked: 1,
    demodLocked: 1,
    snr: 25,
    rssi: -60,
    inBandPower: -55,
    frequency: 629143000,
    transmissionMode: 3,
    guardInterval: 8,
    partialReception: 1,
    layers: [
      {
        codeRate: 1,
        constellation: 0,
        segments: 1,
        ber: 100,
        errors: 2,
        total: 5000,
      },
      {
        codeRate: 2,
        constellation: 2,
        segments: 12,
        ber: 0,
        errors: 0,
        total: 60000,
      },
      {
        codeRate: 255,
        constellation: 255,
        segments: 255,
        ber: 0xffffffff,
        errors: 0,
        total: 0,
      },
    ],
  };
  get supportedProtocols() {
    return this.firmwareId === 255 ? 0 : 1 << this.firmwareId;
  }
  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
    this.closeCount++;
    for (const reader of this.readers.splice(0))
      reader.reject(new Error("Closed"));
  }
  async selectConfiguration() {
    this.configuration = this.configurations[0];
  }
  async claimInterface() {}
  async selectAlternateInterface() {}
  async releaseInterface() {}
  async clearHalt(direction, endpoint) {
    this.halts.push([direction, endpoint]);
  }
  emit(message) {
    let bytes = message;
    if (this.splitResponses && decode(message).type !== M.DVBT_BDA_DATA) {
      const gap = 512 - HEADER + 2;
      bytes = new Uint8Array(gap + message.length);
      bytes.set(message.subarray(0, HEADER));
      bytes[6] |= 4;
      bytes[7] = 2;
      bytes.fill(0xee, HEADER, gap);
      bytes.set(message.subarray(HEADER), gap + HEADER);
    }
    const reader = this.readers.shift();
    if (reader)
      reader.resolve({ status: "ok", data: new DataView(bytes.buffer) });
    else this.outbox.push(bytes);
  }
  respond(type, payload = []) {
    this.emit(encode(type, payload, { src: 11, dst: 201 }));
  }
  flushTs() {
    if (!this.pidFilters.size) return;
    for (const chunk of this.tsChunks.splice(0))
      this.emit(encode(M.DVBT_BDA_DATA, chunk, { src: 11, dst: 1 }));
  }
  statisticsPayload(extended) {
    const s = this.stats;
    const head = [
      5, // statistics_type (ISDBT)
      0, // full_size
      s.rfLocked,
      s.demodLocked,
      0,
      s.snr,
      s.rssi,
      s.inBandPower,
      1234, // carrier offset
      s.frequency,
      6,
      s.transmissionMode,
      s.demodLocked,
      s.guardInterval,
      0,
      s.partialReception,
      s.layers.length,
    ];
    if (extended) head.push(0, 8);
    const layers = s.layers.flatMap((l) => [
      l.codeRate,
      l.constellation,
      l.ber,
      l.errors * 8,
      l.total * 204 * 8,
      0xffffffff,
      0xffffffff,
      l.errors,
      l.total,
      2,
      l.segments,
      0,
    ]);
    const tail = extended
      ? [
          0,
          0,
          87,
          0,
          1,
          40000,
          30000,
          0,
          0x04030201,
          0,
          -3,
          26 * 65536 + 32768,
          0,
          0,
          0,
          0,
        ]
      : [0];
    const body = words(...head, ...layers, ...tail);
    if (!extended) return body;
    const out = new Uint8Array(4 + body.length);
    out.set(body, 4);
    return out;
  }
  async transferOut(ep, request) {
    if (!this.opened) throw new Error("Closed");
    if (ep !== 2) throw new Error("Wrong OUT endpoint");
    const bytes = new Uint8Array(
      request.buffer,
      request.byteOffset,
      request.byteLength,
    );
    const message = decode(bytes);
    if (message.length !== bytes.length) throw new Error("Bad msg_length");
    this.sent.push(message);
    const p = message.payload;
    switch (message.type) {
      case M.GET_VERSION_EX_REQ: {
        const res = new Uint8Array(48);
        new DataView(res.buffer).setUint16(0, this.chipModel, true);
        res.set(
          [
            1,
            0,
            this.firmwareId,
            this.supportedProtocols,
            2,
            1,
            0,
            0,
            ...this.romVersion,
          ],
          2,
        );
        res.set(new TextEncoder().encode("SMS2270 Rio"), 14);
        this.respond(M.GET_VERSION_EX_RES, res);
        break;
      }
      case M.SW_RELOAD_START_REQ:
        this.respond(M.SW_RELOAD_START_RES);
        break;
      case M.DATA_DOWNLOAD_REQ: {
        const address = word(p, 0);
        p.subarray(4).forEach((b, i) => this.memory.set(address + i, b));
        this.respond(M.DATA_DOWNLOAD_RES);
        break;
      }
      case M.DATA_VALIDITY_REQ: {
        let sum = 0;
        const start = word(p, 0);
        for (let i = 0; i + 4 <= word(p, 1); i += 4)
          sum =
            (sum +
              (this.memory.get(start + i) |
                (this.memory.get(start + i + 1) << 8) |
                (this.memory.get(start + i + 2) << 16) |
                (this.memory.get(start + i + 3) << 24))) >>>
            0;
        this.respond(M.DATA_VALIDITY_RES, words(sum));
        break;
      }
      case M.SWDOWNLOAD_TRIGGER_REQ:
        this.firmwareId = 6;
        this.respond(M.SWDOWNLOAD_TRIGGER_RES);
        break;
      case M.SW_RELOAD_EXEC_REQ:
        this.firmwareId = 6;
        break;
      case M.INIT_DEVICE_REQ:
        this.respond(M.INIT_DEVICE_RES);
        break;
      case M.ISDBT_TUNE_REQ:
        this.tunes.push([word(p, 0), word(p, 1), word(p, 2), word(p, 3)]);
        this.respond(M.ISDBT_TUNE_RES);
        break;
      case M.ADD_PID_FILTER_REQ:
        this.pidFilters.add(word(p, 0));
        this.respond(M.ADD_PID_FILTER_RES);
        this.flushTs();
        break;
      case M.REMOVE_PID_FILTER_REQ:
        this.pidFilters.delete(word(p, 0));
        this.respond(M.REMOVE_PID_FILTER_RES);
        break;
      case M.GET_STATISTICS_EX_REQ:
        this.respond(M.GET_STATISTICS_EX_RES, this.statisticsPayload(true));
        break;
      case M.GET_STATISTICS_REQ:
        this.respond(M.GET_STATISTICS_RES, this.statisticsPayload(false));
        break;
    }
    return { status: "ok", bytesWritten: bytes.length };
  }
  transferIn(ep, length) {
    if (!this.opened) return Promise.reject(new Error("Closed"));
    if (ep !== 1) return Promise.reject(new Error("Wrong IN endpoint"));
    if (length < 0x2000) return Promise.reject(new Error("Read too small"));
    const bytes = this.outbox.shift();
    if (bytes)
      return Promise.resolve({
        status: "ok",
        data: new DataView(bytes.buffer),
      });
    return new Promise((resolve, reject) => {
      this.readers.push({ resolve, reject });
    });
  }
}
export function packets(count) {
  const bytes = new Uint8Array(count * 188);
  for (let i = 0; i < count; i++) {
    bytes.fill(i & 255, i * 188, (i + 1) * 188);
    bytes[i * 188] = 0x47;
  }
  return bytes;
}
