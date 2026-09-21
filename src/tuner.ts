// TypeScript port of it9175.c, (c) 2015-2016 trinity19683. GPL-3.0-only.
import { Command, delay } from "./protocol.js";
import { Registers } from "./registers.js";
import { firmware } from "./firmware-data.js";
import { firmwarePackets } from "./firmware.js";
import {
  inittab_1,
  inittab_2,
  init1_mtab,
  init2_mtab,
  init3_mtab,
  init4_mtab,
  params_1,
  params_2,
  SDRAM_CLK,
} from "./tables.js";

export interface DeviceInfo {
  chipId: number;
  firmwareVersion: number;
  tunerId: number;
  eepromValid: boolean;
}
export interface LayerStatistics {
  bitErrors: number;
  totalBits: number;
  uncorrectablePackets: number;
}
export interface Statistics {
  tpsLocked: boolean;
  mpegLocked: boolean;
  quality: number;
  strength: number;
  strengthDbm: number;
  snrDb: number;
  layers: LayerStatistics[];
}
export interface Tmcc {
  mode: number;
  guardIntervalDenominator: number;
  partialReception: boolean;
  layers: {
    segments: number;
    modulation: number;
    codeRate: number;
    interleave: number;
  }[];
}
export interface TuningResult {
  status: "locked" | "empty" | "timeout";
  elapsedMs: number;
}
export interface StreamLockResult {
  locked: boolean;
  overflow: boolean;
  elapsedMs: number;
}
const ndiv = [48, 32, 24, 16, 12, 8, 6, 4, 2];
const le = (value: number, length: number) =>
  Uint8Array.from({ length }, (_, i) => (value >>> (i * 8)) & 255);
export function channelFrequency(channel: number): number {
  if (!Number.isInteger(channel) || channel < 13 || channel > 62)
    throw new RangeError("UHF channel must be 13–62");
  return 473143 + (channel - 13) * 6000;
}
export function sdramClock(frequency: number): number {
  const indices = [0, 12, 17, 23, 63, 113];
  const low = [90143, 164143, 192143, 230143, 470143];
  for (let j = 4; j >= 0; j--) {
    if (frequency >= low[j])
      return SDRAM_CLK[
        indices[j] +
          Math.min(
            Math.floor((frequency - low[j]) / 6000),
            indices[j + 1] - indices[j] - 1,
          )
      ];
  }
  return SDRAM_CLK[0];
}
export class Tuner {
  private clockMode = 0;
  private xtal = 2000;
  private fdiv = 3;
  private boundaries = [
    78200, 117300, 156400, 234600, 312800, 469200, 625600, 950000,
  ];
  constructor(readonly regs: Registers) {}
  private async identify(): Promise<{
    chipId: number;
    firmwareVersion: number;
  }> {
    const chip = await this.regs.read(0x1222, 3);
    const pre = await this.regs.byte(0x384f);
    const chipId =
      ((chip[2] << 24) | (chip[1] << 16) | (pre << 8) | chip[0]) >>> 0;
    if (chipId !== 0x91758301)
      throw new Error(
        `Unsupported chip 0x${chipId.toString(16)} (expected 91758301)`,
      );
    const fw = await this.regs.transport.command(
      Command.firmwareQuery,
      0,
      Uint8Array.of(1),
      4,
    );
    return {
      chipId,
      firmwareVersion: new DataView(fw.buffer, fw.byteOffset, 4).getUint32(
        0,
        true,
      ),
    };
  }
  async initialize(image: Uint8Array = firmware): Promise<DeviceInfo> {
    const r = this.regs;
    let identity = await this.identify();
    const eepromValid = (await r.byte(0x461c)) !== 0;
    let tunerId = 0x70;
    if (eepromValid) {
      await r.byte(0x499c + 0x10);
      await r.byte(0x499c + 0x29);
      tunerId = await r.byte(0x499c + 0x34);
      await r.byte(0x499c + 0x2b);
    }
    await r.byte(0xd800);
    if (!identity.firmwareVersion) {
      const packets = firmwarePackets(image);
      await r.write(0xf103, 7);
      for (const packet of packets)
        await r.transport.command(Command.firmwareScatter, 0, packet);
      await r.transport.command(Command.firmwareBoot);
      identity = await this.identify();
      if (!identity.firmwareVersion) throw new Error("Firmware did not boot");
    }
    await r.write(0xf103, 0x1a);
    await r.write(0x4bfb, 0);
    await r.write(0xcfff, 0);
    await r.write(0xf641, tunerId);
    await r.table(init1_mtab);
    await r.write(0x800025, le(Math.floor((12000000 * 2 ** 19) / 1000000), 4));
    await r.write(0x80f1cd, le(Math.floor((20250000 * 2 ** 19) / 1000000), 3));
    await r.data(inittab_1);
    await r.data(inittab_2);
    await r.write(0x80004e, 0);
    await r.write(0x800000, 1);
    await delay(30);
    await r.write(0xd827, 0);
    await r.write(0xd829, 0);
    this.clockMode = await r.byte(0x80ec86);
    this.xtal =
      this.clockMode === 0 ? 2000 : this.clockMode === 1 ? 20480 : 640;
    this.fdiv = this.clockMode === 0 ? 3 : this.clockMode === 1 ? 18 : 1;
    const count = await r.byte(0x80ed03);
    if (count > 8) throw new Error("Invalid tuner calibration boundary count");
    await delay(10);
    let calibration = 0;
    for (let i = 0; i < 15; i++) {
      const bytes = await r.read(0x80ed23, 2);
      calibration = (bytes[1] << 8) | bytes[0];
      if (calibration) break;
      await delay(5);
    }
    if (count) {
      if (!calibration) throw new Error("Tuner calibration timed out");
      const frequency = Math.floor((calibration * 4 * this.xtal) / this.fdiv);
      for (let i = 0; i < count; i++)
        this.boundaries[i] = Math.floor(frequency / ndiv[i + 1]) >>> 2;
    }
    await delay(20);
    for (let i = 0; i < 10; i++) {
      if (await r.byte(0x80ec82)) break;
      await delay(10);
    }
    await r.write(0x80ed81, this.clockMode === 0 ? 16 : 6);
    await this.checkDemod();
    await r.table(init2_mtab);
    await r.mask(0x80cfff, 0, 3);
    await r.mask(0xcfff, 0, 3);
    await r.table(init3_mtab);
    await r.write(0xdd88, le((305 * 188) / 4, 2));
    await r.write(0xdd0c, 128);
    await r.table(init4_mtab);
    await r.write(0x80f996, [0xff, 0x1f]);
    await r.write(0x80f995, 0);
    await r.mask(0x80f994, 1, 1);
    return { ...identity, tunerId, eepromValid };
  }
  private async checkDemod(): Promise<void> {
    if ((await this.regs.byte(0x8001dc)) !== 1)
      throw new Error("Demodulator configuration error");
  }
  async setFrequency(frequency: number): Promise<void> {
    if (
      !Number.isInteger(frequency) ||
      frequency < 53000 ||
      frequency >= 860000
    )
      throw new RangeError("Frequency must be 53000–859999 kHz");
    const r = this.regs;
    await r.mask(0x80cfff, 0, 3);
    await r.write(0x80011b, params_1);
    await r.write(0x800001, params_2);
    await r.write(0x800040, 0);
    await r.write(0x800047, 0);
    await r.mask(0x80f999, 0, 1);
    await r.write(0x80004b, frequency > 300000 ? 1 : 0);
    if (await r.byte(0x8001c6)) {
      const value = sdramClock(frequency) << 3;
      for (const [address, data] of [
        [0x80fb25, 0x65],
        [0x80fbb5, (value >> 8) | 0x30],
        [0x80fbb6, value & 255],
        [0x80fbb7, 4],
        [0x80fbb9, 0x4a],
        [0x80fbb9, 0x48],
        [0x80fbba, 0x40],
      ])
        await r.write(address, data);
    }
    await this.checkDemod();
    let index = this.boundaries.findIndex((upper) => upper >= frequency);
    if (index < 0) index = 8;
    const divider = ndiv[index];
    let lo = Math.floor(
      (Math.floor((2 * frequency * divider * this.fdiv) / this.xtal) + 1) / 2,
    );
    let band = [
      444000, 484000, 533000, 587000, 645000, 710000, 782000, 860000,
    ].findIndex((upper) => upper >= frequency);
    if (band < 0) band = 7;
    const ec4c = await r.byte(0x80ec4c);
    const ed81 = await r.byte(0x80ed81);
    const cal = ((ed81 & 31) - (ed81 & 32)) * divider;
    const iqik = this.clockMode === 0 ? (cal * 9) >> 5 : cal >> 1;
    await r.write(0x800160, band);
    await r.write(0x80ec56, 2);
    await r.write(0x80ec4c, (ec4c & 0xe7) | (frequency >= 312000 ? 8 : 0));
    lo |= index << 13;
    const adjusted = lo + iqik;
    await r.write(0x80ec4d, adjusted & 255);
    await r.write(0x80ec4e, (adjusted >> 8) & 255);
    await r.write(0x80015e, lo & 255);
    await r.write(0x80015f, (lo >> 8) & 255);
    await this.checkDemod();
    await r.mask(0xd8cf, 1, 1);
    await r.write(0x8001e3, 0);
    lo = (((index - 2) & 255) << 13) | (lo & 0x1fff);
    await r.write(0x8001e1, lo & 255);
    await r.write(0x8001e2, (lo >> 8) & 255);
    await r.write(0x800000, 0);
  }
  async waitTuning(timeoutMs = 1500): Promise<TuningResult> {
    const start = performance.now();
    let previous = 2;
    while (performance.now() - start < timeoutMs) {
      const value = await this.regs.byte(0x800047);
      if (value === previous && (value === 1 || value === 2))
        return {
          status: value === 1 ? "locked" : "empty",
          elapsedMs: performance.now() - start,
        };
      previous = value;
      await delay(40);
    }
    return { status: "timeout", elapsedMs: performance.now() - start };
  }
  async waitStream(timeoutMs = 1500): Promise<StreamLockResult> {
    const start = performance.now();
    let locked = false;
    while (performance.now() - start < timeoutMs) {
      if ((await this.regs.byte(0x80f999)) & 1) {
        locked = true;
        break;
      }
      await delay(32);
    }
    const overflow = !!((await this.regs.byte(0x80f980)) & 1);
    if (overflow) await this.regs.write(0x80f980, 0);
    return { locked, overflow, elapsedMs: performance.now() - start };
  }
  async readTmcc(): Promise<Tmcc> {
    const bytes = await this.regs.read(0x80f900, 3);
    const mode = [1, 3, 2, 0][bytes[0] & 3];
    const result: Tmcc = {
      mode,
      guardIntervalDenominator: 32 >> (bytes[1] & 3),
      partialReception: !!(bytes[2] & 1),
      layers: [],
    };
    for (let j = 0; j < 3; j++) {
      const b = await this.regs.read(0x80f903 + j * 4, 4);
      const modulation = b[0] & 7,
        rate = b[1] & 7,
        time = b[2] & 7;
      result.layers.push(
        modulation === 7
          ? { segments: 0, modulation: 0, codeRate: 0, interleave: 0 }
          : {
              segments: b[3] & 15,
              modulation: Math.min(modulation, 4),
              codeRate: Math.min(rate, 5),
              interleave: (time > 3 ? 0 : 4 >> (3 - time)) << (3 - mode),
            },
      );
    }
    return result;
  }
  async readStatistics(): Promise<Statistics> {
    const r = this.regs,
      lock = await r.read(0x80003c, 2),
      quality = await r.byte(0x800049);
    const strength = await r.read(0x80013e, 2),
      snrDb = await r.byte(0x8001c9);
    const layers: LayerStatistics[] = [];
    for (const address of [0x800032, 0x8000f3, 0x8000fc]) {
      const b = await r.read(address, 7);
      layers.push({
        bitErrors: (b[4] << 16) | (b[3] << 8) | b[2],
        totalBits: ((b[6] << 8) | b[5]) * 204 * 8,
        uncorrectablePackets: (b[1] << 8) | b[0],
      });
    }
    return {
      tpsLocked: !!(lock[0] & 1),
      mpegLocked: !!(lock[1] & 1),
      quality,
      strength: strength[0],
      strengthDbm: strength[1] - 100,
      snrDb,
      layers,
    };
  }
  async sleep(): Promise<void> {
    const r = this.regs;
    await r.mask(0x80fbb9, 0, 0x20);
    await r.write(0xe00c, 1);
    await r.mask(0x80fbb9, 0x20, 0x20);
    await r.write(0x80004c, 1);
    await r.write(0x800000, 0);
    await delay(30);
    for (let i = 0; i < 20; i++) {
      if ((await r.byte(0x80004c)) === 0) break;
      await delay(25);
    }
    await r.write(0x80fb24, 8);
    await r.write(0x80fba8, 0);
    await r.write(0x80ec40, 0);
    const buffer = new Uint8Array(15);
    buffer[1] = 12;
    await r.write(0x80ec02, buffer);
    buffer[1] = 0;
    await r.write(0x80ec12, buffer.subarray(0, 4));
    await r.write(0x80ec17, buffer.subarray(0, 9));
    await r.write(0x80ec22, buffer.subarray(0, 10));
    await r.write(0x80ec20, 0);
    await r.write(0x80ec3f, 1);
  }
}
