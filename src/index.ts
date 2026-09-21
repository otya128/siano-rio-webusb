import { browserUsb, type DeviceFilter, type UsbDevice } from "./usb.js";
import { WebUsbTransport } from "./transport.js";
import { SmsCore, type DeviceInfo } from "./core.js";
import {
  channelFrequency,
  IsdbtFrontend,
  type FrontendStatus,
  type Statistics,
  type TuneOptions,
} from "./isdbt.js";
import {
  DeviceMode,
  type DeviceModeValue,
  Msg,
  messageName,
} from "./messages.js";
import { SerialQueue, type Message } from "./protocol.js";
import { TsPacketFramer } from "./ts.js";
export { browserUsb } from "./usb.js";
export type { UsbDevice, UsbAccess, DeviceFilter } from "./usb.js";
export { channelFrequency, parseIsdbtStatistics } from "./isdbt.js";
export type {
  Statistics,
  LayerStatistics,
  Modulation,
  CodeRate,
  TuneOptions,
  IsdbtBandwidth,
  FrontendStatus,
} from "./isdbt.js";
export { parseVersion } from "./core.js";
export type { DeviceInfo, VersionInfo, StartOptions } from "./core.js";
export { parseFirmware } from "./firmware.js";
export type { FirmwareImage } from "./firmware.js";
export {
  Msg,
  messageName,
  DeviceMode,
  Bandwidth,
  DeviceType,
} from "./messages.js";
export {
  ProtocolError,
  encodeMessage,
  decodeHeader,
  decodeMessage,
  HEADER_SIZE,
  USB_BUFFER_SIZE,
} from "./protocol.js";
export type { Message, MessageHeader } from "./protocol.js";
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

/** smsusb_id_table entries with SMS1XXX_BOARD_SIANO_RIO. */
export const USB_FILTERS: readonly DeviceFilter[] = [
  { vendorId: 0x187f, productId: 0x0600 },
  { vendorId: 0x3275, productId: 0x0080 },
];
/** dvb_demux feed for the whole transport stream. */
export const PID_ALL = 0x2000;
export interface OpenOptions {
  /** Bulk OUT deadline in milliseconds. */
  timeoutMs?: number;
  /** isdbt_rio.inp; needed when the device still runs its ROM or firmware for another mode. */
  firmware?: Uint8Array;
  mode?: DeviceModeValue;
  /** Bulk IN transfers kept queued (MAX_URBS). */
  pendingReads?: number;
  log?: (line: string) => void;
}
export interface StreamOptions {
  signal?: AbortSignal;
  /** PID filters to add for the stream's lifetime; [PID_ALL] by default. */
  pids?: readonly number[];
  /** Data queued beyond this is dropped, oldest first, when the consumer falls behind. */
  maxQueuedBytes?: number;
}
interface Consumer {
  queue: Uint8Array[];
  queued: number;
  limit: number;
  dropped: number;
  wake?: () => void;
}

export class SianoRio {
  private readonly operations = new SerialQueue();
  private readonly frontend: IsdbtFrontend;
  private consumer?: Consumer;
  private closing = false;
  private closePromise?: Promise<void>;
  private failure?: Error;
  readonly info: Readonly<DeviceInfo>;
  private constructor(
    private readonly transport: WebUsbTransport,
    core: SmsCore,
    info: DeviceInfo,
    private readonly log?: (line: string) => void,
  ) {
    this.frontend = new IsdbtFrontend(core);
    this.info = Object.freeze(info);
    transport.onMessage = (message) => this.handleMessage(message);
    transport.onError = (error) => {
      this.failure = error;
      this.consumer?.wake?.();
    };
  }
  /** Invoke directly from a user gesture. */
  static async request(
    options: OpenOptions & { filters?: DeviceFilter[] } = {},
  ): Promise<SianoRio> {
    const device = await browserUsb().requestDevice({
      filters: options.filters ?? [...USB_FILTERS],
    });
    return SianoRio.open(device, options);
  }
  /** smsusb_probe(): claim the interface, start reading, then smscore_start_device(). */
  static async open(
    device: UsbDevice,
    options: OpenOptions = {},
  ): Promise<SianoRio> {
    const transport = await WebUsbTransport.open(device, {
      timeoutMs: options.timeoutMs,
      pendingReads: options.pendingReads,
      log: options.log,
    });
    const core = new SmsCore(transport, options.log);
    // Messages arriving during start-up outside a request are indications; log and drop them.
    transport.onMessage = (message) =>
      options.log?.(`message ${messageName(message.type)} not handled.`);
    try {
      const info = await core.start({
        mode: options.mode ?? DeviceMode.ISDBT_BDA,
        firmware: options.firmware,
        log: options.log,
      });
      if (!IsdbtFrontend.isIsdbtMode(info.mode))
        throw new Error(`Device mode ${info.mode} is not ISDB-T`);
      return new SianoRio(transport, core, info, options.log);
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
  /** Lock state as last reported by statistics or an indication. */
  get status(): FrontendStatus {
    return this.frontend.status;
  }
  get lastStatistics(): Statistics | undefined {
    return this.frontend.lastStatistics;
  }
  get pidFilters(): readonly number[] {
    return this.frontend.pidFilters;
  }
  /** Bytes discarded because the active stream consumer fell behind. */
  get droppedBytes(): number {
    return this.consumer?.dropped ?? 0;
  }
  private handleMessage(message: Message): void {
    if (message.type === Msg.MSG_SMS_DVBT_BDA_DATA) {
      const consumer = this.consumer;
      if (!consumer) return; // no feed listening, as smsdvb_onresponse() without feed_users
      consumer.queue.push(message.payload);
      consumer.queued += message.payload.length;
      while (consumer.queued > consumer.limit && consumer.queue.length > 1) {
        const dropped = consumer.queue.shift()!;
        consumer.queued -= dropped.length;
        consumer.dropped += dropped.length;
      }
      consumer.wake?.();
      return;
    }
    if (!this.frontend.handleMessage(message))
      this.log?.(`message ${messageName(message.type)} not handled.`);
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Device is closed"));
    return this.operations.run(async () => {
      if (this.closed) throw new Error("Device is closed");
      return operation();
    });
  }
  /** MSG_SMS_ISDBT_TUNE_REQ; resolves when the firmware acknowledges, before lock. */
  tune(frequencyKHz: number, options?: TuneOptions): Promise<void> {
    if (!Number.isInteger(frequencyKHz))
      return Promise.reject(new RangeError("Frequency must be an integer"));
    return this.run(() => this.frontend.tune(frequencyKHz * 1000, options));
  }
  async tuneChannel(channel: number, options?: TuneOptions): Promise<void> {
    await this.tune(channelFrequency(channel), options);
  }
  readStatistics(): Promise<Statistics> {
    return this.run(() => this.frontend.readStatistics());
  }
  waitLock(timeoutMs = 2000): Promise<Statistics> {
    return this.run(() => this.frontend.waitLock(timeoutMs));
  }
  addPidFilter(pid: number): Promise<void> {
    return this.run(() => this.frontend.addPidFilter(pid));
  }
  removePidFilter(pid: number): Promise<void> {
    return this.run(() => this.frontend.removePidFilter(pid));
  }
  /** One consumer, packet-aligned chunks. Ending the stream removes its PID filters but keeps the device open. */
  async *stream(
    options: StreamOptions = {},
  ): AsyncGenerator<Uint8Array<ArrayBuffer>> {
    const limit = options.maxQueuedBytes ?? 8 * 1024 * 1024;
    if (!Number.isFinite(limit) || limit <= 0)
      throw new RangeError("Invalid queue limit");
    const pids = [...new Set(options.pids ?? [PID_ALL])];
    const consumer: Consumer = { queue: [], queued: 0, limit, dropped: 0 };
    await this.run(async () => {
      if (this.consumer) throw new Error("Only one TS consumer is supported");
      if (options.signal?.aborted)
        throw options.signal.reason ?? new Error("Stream aborted");
      this.consumer = consumer;
      for (const pid of pids) await this.frontend.addPidFilter(pid);
    });
    const framer = new TsPacketFramer();
    const wake = () => consumer.wake?.();
    options.signal?.addEventListener("abort", wake, { once: true });
    try {
      while (!this.closed && !options.signal?.aborted && !this.failure) {
        const chunk = consumer.queue.shift();
        if (!chunk) {
          await new Promise<void>((resolve) => {
            consumer.wake = resolve;
          });
          consumer.wake = undefined;
          continue;
        }
        consumer.queued -= chunk.length;
        const data = framer.push(chunk);
        if (data.length) yield data;
      }
      if (this.failure && !options.signal?.aborted) throw this.failure;
    } finally {
      options.signal?.removeEventListener("abort", wake);
      this.consumer = undefined;
      if (!this.closed)
        await this.run(async () => {
          for (const pid of pids) await this.frontend.removePidFilter(pid);
        }).catch(() => undefined);
    }
  }
  /** Idempotent. smsusb_disconnect() only stops the transfers; PID filters are removed first here. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.consumer?.wake?.();
    this.closePromise = (async () => {
      try {
        if (!this.transport.closed)
          for (const pid of this.frontend.pidFilters)
            await this.frontend.removePidFilter(pid);
      } catch {
        // the device may already be gone
      } finally {
        await this.transport.close();
      }
    })();
    return this.closePromise;
  }
}
