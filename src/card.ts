// T=1 reader port of it9175.c and scard.cpp. GPL-3.0-only.
import { Command, delay, ProtocolError } from "./protocol.js";
import { Registers } from "./registers.js";
export const MAX_APDU_LENGTH = 53; // 64 - USB headers/checksum (6) - card header/LRC (5)
export const lrc = (bytes: Uint8Array): number =>
  bytes.reduce((value, byte) => value ^ byte, 0);
export function cardBlock(pcb: number, data: Uint8Array): Uint8Array {
  if (data.length > 254)
    throw new RangeError("T=1 information field exceeds 254 bytes");
  const result = new Uint8Array(data.length + 4);
  result.set([0, pcb, data.length]);
  result.set(data, 3);
  result[result.length - 1] = lrc(result);
  return result;
}
export function parseCardBlock(block: Uint8Array): {
  pcb: number;
  data: Uint8Array;
} {
  if (block.length < 4 || block.length !== block[2] + 4)
    throw new ProtocolError("Invalid T=1 block length");
  if (block[0] !== 0 || lrc(block) !== 0)
    throw new ProtocolError("Invalid T=1 NAD or LRC");
  return { pcb: block[1], data: block.slice(3, -1) };
}
/** Single I-block exchange, as in upstream. Unsupported chaining/WTX is rejected explicitly. */
export class CardReader {
  private initialized = false;
  private sequence = 0;
  private atrBytes = new Uint8Array(0);
  constructor(private readonly regs: Registers) {}
  get atr(): Uint8Array {
    return this.atrBytes.slice();
  }
  invalidate(): void {
    this.initialized = false;
    this.sequence = 0;
    this.atrBytes = new Uint8Array(0);
  }
  async present(): Promise<boolean> {
    return (await this.regs.byte(0x80fba5)) === 0;
  }
  private async check(): Promise<void> {
    if (!(await this.present())) {
      this.invalidate();
      throw new Error("Smart card is not present or recognized");
    }
  }
  private async send(pcb: number, data: Uint8Array): Promise<void> {
    if (data.length > MAX_APDU_LENGTH)
      throw new RangeError(`APDU must fit in ${MAX_APDU_LENGTH} bytes`);
    const block = cardBlock(pcb, data);
    const payload = new Uint8Array(block.length + 1);
    payload[0] = block.length;
    payload.set(block, 1);
    await this.regs.transport.command(Command.cardWrite, 0x80, payload);
  }
  private async receive(maximum: number): Promise<Uint8Array<ArrayBuffer>> {
    const chunks: Uint8Array[] = [];
    let length = 0;
    const deadline = performance.now() + 1000;
    while (true) {
      const remain = await this.regs.byte(0x8001cb);
      if (!remain) break;
      const size = Math.min(remain, 32);
      if (length + size > maximum)
        throw new ProtocolError("Card response exceeds receive buffer");
      if (performance.now() >= deadline)
        throw new Error("Card FIFO drain timed out");
      chunks.push(
        await this.regs.transport.command(
          Command.cardRead,
          0x80,
          Uint8Array.of(size),
          size,
        ),
      );
      length += size;
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
  private async wait(timeoutMs = 1000): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (await this.regs.byte(0x8001e8)) return;
      await delay(10);
    }
    throw new Error("Smart card response timed out");
  }
  async reset(): Promise<Uint8Array> {
    this.invalidate();
    try {
      await this.check();
      for (let i = 0; i < 2; i++) {
        await this.regs.write(0xd8b7, 0);
        await this.regs.write(0x8001eb, 2);
        await this.regs.transport.command(
          Command.cardMode,
          0x80,
          Uint8Array.of(0),
        );
        await this.regs.write(0xd8b7, 1);
      }
      await this.check();
      await delay(200);
      this.atrBytes = await this.receive(33);
      if (!this.atrBytes.length) throw new Error("Card did not return an ATR");
      await this.regs.transport.command(
        Command.cardMode,
        0x80,
        Uint8Array.of(1),
      );
      await this.regs.write(0x8001ec, 1);
      await this.send(0xc1, Uint8Array.of(0xfe));
      await this.wait();
      const ifs = parseCardBlock(await this.receive(5));
      if (ifs.pcb !== 0xe1 || ifs.data.length !== 1 || ifs.data[0] !== 0xfe)
        throw new ProtocolError("Invalid card IFS response");
      this.initialized = true;
      return this.atr;
    } catch (error) {
      this.invalidate();
      throw error;
    }
  }
  async transmit(apdu: Uint8Array): Promise<Uint8Array> {
    if (!apdu.length || apdu.length > MAX_APDU_LENGTH)
      throw new RangeError(
        `APDU length must be 1–${MAX_APDU_LENGTH} bytes; command chaining is unsupported`,
      );
    try {
      if (!this.initialized) await this.reset();
      await this.check();
      await this.regs.write(0x8001ec, 1);
      await this.send(this.sequence & 1 ? 0x40 : 0, apdu);
      const expectedPcb = this.sequence & 1 ? 0x40 : 0;
      this.sequence++;
      await this.wait();
      const reply = parseCardBlock(await this.receive(258));
      if (reply.pcb !== expectedPcb)
        throw new ProtocolError(
          `Unsupported or out-of-sequence T=1 PCB 0x${reply.pcb.toString(16)}; card reset required`,
        );
      return reply.data;
    } catch (error) {
      this.invalidate();
      throw error;
    }
  }
}
