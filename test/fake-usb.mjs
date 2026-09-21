export class FakeUsb {
  opened = false;
  vendorId = 0x1234;
  productId = 0x5678;
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
                { endpointNumber: 2, direction: "out", type: "bulk" },
                { endpointNumber: 1, direction: "in", type: "bulk" },
                { endpointNumber: 4, direction: "in", type: "bulk" },
              ],
            },
          ],
        },
      ],
    },
  ];
  configuration = null;
  registers = new Map([
    [0x1222, 1],
    [0x1223, 0x75],
    [0x1224, 0x91],
    [0x384f, 0x83],
    [0x461c, 1],
    [0x49d0, 0x70],
    [0x80ed03, 8],
    [0x80ed23, 0xe9],
    [0x80ed24, 0x15],
    [0x80ec82, 1],
    [0x8001dc, 1],
    [0x8001e8, 1],
    [0x80fba5, 0],
  ]);
  writes = [];
  firmwareLoaded = true;
  cardFifo = [];
  responsePcb = 0;
  commands = [];
  closeCount = 0;
  tsChunks = [];
  pendingTs;
  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
    this.closeCount++;
    this.pendingTs?.reject(new Error("Closed"));
  }
  async selectConfiguration() {
    this.configuration = this.configurations[0];
  }
  async claimInterface() {}
  async selectAlternateInterface() {}
  async releaseInterface() {}
  async transferOut(ep, request) {
    if (!this.opened) throw new Error("Closed");
    if (ep !== 2) throw new Error("Wrong OUT endpoint");
    const bytes = new Uint8Array(
      request.buffer,
      request.byteOffset,
      request.byteLength,
    );
    this.request = bytes.slice();
    this.commands.push(this.request);
    const p = bytes.subarray(4, -2),
      command = bytes[2];
    const address = (bytes[1] << 16) | (p[4] << 8) | p[5];
    if (command === 1) {
      for (let i = 0; i < p[0]; i++) this.registers.set(address + i, p[6 + i]);
      this.writes.push([address, [...p.subarray(6)]]);
      if (address === 0xd8b7 && p[6] === 1) this.cardFifo = [0x3b, 0x00];
    }
    if (command === 0x23) this.firmwareLoaded = true;
    if (command === 5) {
      const pcb = p[2] === 0xc1 ? 0xe1 : this.responsePcb;
      const data = p[2] === 0xc1 ? [0xfe] : [0x90, 0];
      this.cardFifo = [0, pcb, data.length, ...data];
      this.cardFifo.push(this.cardFifo.reduce((a, b) => a ^ b, 0));
      if (pcb !== 0xe1) this.responsePcb ^= 0x40;
    }
    return { status: "ok", bytesWritten: bytes.length };
  }
  async transferIn(ep, length) {
    if (!this.opened) throw new Error("Closed");
    if (ep === 4) {
      if (this.tsChunks.length)
        return {
          status: "ok",
          data: new DataView(this.tsChunks.shift().buffer),
        };
      return new Promise((resolve, reject) => {
        this.pendingTs = { resolve, reject };
      });
    }
    if (ep !== 1) throw new Error("Wrong IN endpoint");
    const request = this.request,
      p = request.subarray(4, -2),
      command = request[2];
    const response = new Uint8Array(length);
    response.set([length - 1, request[3], 0]);
    const address = (request[1] << 16) | (p[4] << 8) | p[5];
    if (command === 0) {
      for (let i = 0; i < p[0]; i++)
        response[3 + i] =
          address === 0x8001cb
            ? this.cardFifo.length
            : (this.registers.get(address + i) ?? 0);
    }
    if (command === 4) response.set(this.cardFifo.splice(0, p[0]), 3);
    if (command === 0x22 && this.firmwareLoaded) response.set([1, 2, 3, 4], 3);
    // Independent implementation of upstream checksum.
    let sum = 0;
    for (let i = 1; i < length - 2; i += 2)
      sum += (response[i] << 8) + (i + 1 < length - 2 ? response[i + 1] : 0);
    const check = 0xffff - (sum & 0xffff);
    response[length - 2] = check >>> 8;
    response[length - 1] = check & 255;
    return { status: "ok", data: new DataView(response.buffer) };
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
