import { Command } from "./protocol.js";
export interface CommandTransport {
  command(
    command: number,
    mailbox?: number,
    payload?: Uint8Array,
    readLength?: number,
  ): Promise<Uint8Array>;
}
export class Registers {
  constructor(readonly transport: CommandTransport) {}
  private header(address: number, length: number): Uint8Array<ArrayBuffer> {
    if (!Number.isInteger(address) || address < 0 || address > 0xffffff)
      throw new RangeError("Invalid register address");
    return new Uint8Array([
      length,
      2,
      0,
      0,
      (address >> 8) & 255,
      address & 255,
    ]);
  }
  read(address: number, length = 1): Promise<Uint8Array> {
    if (!Number.isInteger(length) || length < 1 || length > 59)
      throw new RangeError("Register read length must be 1–59");
    return this.transport.command(
      Command.read,
      address >>> 16,
      this.header(address, length),
      length,
    );
  }
  async byte(address: number): Promise<number> {
    return (await this.read(address))[0];
  }
  async write(
    address: number,
    value: number | ArrayLike<number>,
  ): Promise<void> {
    const data =
      typeof value === "number" ? Uint8Array.of(value) : Uint8Array.from(value);
    if (data.length < 1 || data.length > 52)
      throw new RangeError("Register write length must be 1–52");
    const payload = new Uint8Array(6 + data.length);
    payload.set(this.header(address, data.length));
    payload.set(data, 6);
    await this.transport.command(Command.write, address >>> 16, payload);
  }
  async mask(address: number, value: number, mask: number): Promise<void> {
    const result =
      mask === 0 || mask === 255
        ? value
        : ((await this.byte(address)) & ~mask) | (value & mask);
    await this.write(address, result);
  }
  async table(
    table: readonly (readonly [number, number, number])[],
  ): Promise<void> {
    for (const [address, value, mask] of table)
      await this.mask(address, value, mask);
  }
  async data(table: Uint8Array): Promise<void> {
    for (let i = 0; table[i]; i += table[i] + 3) {
      await this.write(
        0x800000 | (table[i + 2] << 8) | table[i + 1],
        table.subarray(i + 3, i + 3 + table[i]),
      );
    }
  }
}
