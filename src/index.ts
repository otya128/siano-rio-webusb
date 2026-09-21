import { browserUsb, type DeviceFilter, type UsbDevice } from "./usb.js";
import { WebUsbTransport } from "./transport.js";
import { Registers } from "./registers.js";
import { SerialQueue } from "./protocol.js";
import { Tuner, channelFrequency, type DeviceInfo } from "./tuner.js";
import { CardReader } from "./card.js";
import { TsPacketFramer } from "./ts.js";
export { browserUsb } from "./usb.js";
export type { UsbDevice, UsbAccess, DeviceFilter } from "./usb.js";
export { channelFrequency } from "./tuner.js";
export type {
  DeviceInfo,
  Statistics,
  LayerStatistics,
  Tmcc,
  TuningResult,
  StreamLockResult,
} from "./tuner.js";
export { MAX_APDU_LENGTH } from "./card.js";
export { ProtocolError, TS_TRANSFER_SIZE } from "./protocol.js";
export { TsPacketFramer } from "./ts.js";
export {
  OneSegFilter,
  AccessUnitSplitter,
  AdtsRepacketizer,
  SectionAssembler,
  crc32Mpeg2,
  isPartialReceptionPmtPid,
  PLAYABLE_STREAM_TYPES,
} from "./oneseg.js";
export type { TsProgram, ProgramFilterOptions } from "./oneseg.js";
export interface OpenOptions {
  timeoutMs?: number;
  firmware?: Uint8Array;
}
export interface StreamOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class Fsusb2i {
  private readonly operations = new SerialQueue();
  private readonly tuner: Tuner;
  private readonly card: CardReader;
  private streaming = false;
  private closing = false;
  private closePromise?: Promise<void>;
  readonly info: Readonly<DeviceInfo>;
  private constructor(
    private readonly transport: WebUsbTransport,
    tuner: Tuner,
    info: DeviceInfo,
  ) {
    this.tuner = tuner;
    this.card = new CardReader(tuner.regs);
    this.info = Object.freeze(info);
  }
  /** Invoke directly from a user gesture. Upstream specifies a Windows GUID, not VID/PID. */
  static async request(
    options: OpenOptions & { filters?: DeviceFilter[] } = {},
  ): Promise<Fsusb2i> {
    const device = await browserUsb().requestDevice({
      filters: options.filters ?? [],
    });
    return Fsusb2i.open(device, options);
  }
  static async open(
    device: UsbDevice,
    options: OpenOptions = {},
  ): Promise<Fsusb2i> {
    const transport = await WebUsbTransport.open(device, options.timeoutMs);
    const tuner = new Tuner(new Registers(transport));
    try {
      return new Fsusb2i(
        transport,
        tuner,
        await tuner.initialize(options.firmware),
      );
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }
  get device(): UsbDevice {
    return this.transport.device;
  }
  get closed(): boolean {
    return this.closing || this.transport.closed || !this.device.opened;
  }
  get atr(): Uint8Array {
    return this.card.atr;
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Device is closed"));
    return this.operations.run(async () => {
      if (this.closed) throw new Error("Device is closed");
      return operation();
    });
  }
  setFrequency(khz: number): Promise<void> {
    return this.run(() => {
      if (this.streaming)
        throw new Error("Close the active TS stream before retuning");
      return this.tuner.setFrequency(khz);
    });
  }
  setChannel(channel: number): Promise<void> {
    return this.setFrequency(channelFrequency(channel));
  }
  waitTuning(timeoutMs = 1500) {
    return this.run(() => this.tuner.waitTuning(timeoutMs));
  }
  waitStream(timeoutMs = 1500) {
    return this.run(() => this.tuner.waitStream(timeoutMs));
  }
  readStatistics() {
    return this.run(() => this.tuner.readStatistics());
  }
  readTmcc() {
    return this.run(() => this.tuner.readTmcc());
  }
  cardPresent() {
    return this.run(() => this.card.present());
  }
  resetCard() {
    return this.run(() => this.card.reset());
  }
  transmitCard(apdu: Uint8Array) {
    const data = apdu.slice();
    return this.run(() => this.card.transmit(data));
  }
  /** One consumer, packet-aligned chunks, pull-based backpressure. Ending a stream closes USB. */
  async *stream(
    options: StreamOptions = {},
  ): AsyncGenerator<Uint8Array<ArrayBuffer>> {
    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    )
      throw new RangeError("Invalid stream timeout");
    await this.run(async () => {
      if (this.streaming) throw new Error("Only one TS consumer is supported");
      if (options.signal?.aborted)
        throw options.signal.reason ?? new Error("Stream aborted");
      this.streaming = true;
    });
    const framer = new TsPacketFramer();
    const abort = () => {
      void this.close().catch(() => undefined);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (options.signal?.aborted) return;
      while (!this.closed && !options.signal?.aborted) {
        const data = framer.push(
          await this.transport.readTs(options.timeoutMs),
        );
        if (this.closed || options.signal?.aborted) break;
        if (data.length) yield data;
      }
    } catch (error) {
      if (!options.signal?.aborted && !this.closing) throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
      await this.close();
      this.streaming = false;
    }
  }
  /** Idempotent, closes pending USB reads immediately when a stream is active. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.card.invalidate();
    this.closePromise =
      this.streaming || this.transport.closed
        ? this.transport.close()
        : this.operations.run(async () => {
            try {
              await this.tuner.sleep();
            } finally {
              await this.transport.release();
            }
          });
    return this.closePromise;
  }
}
