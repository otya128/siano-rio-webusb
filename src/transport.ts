// WebUSB port of smsusb.c (Siano Mobile Silicon, Uri Shkolnik, Anatoly Greenblat). GPL-2.0-or-later.
import type { UsbDevice, UsbEndpoint } from "./usb.js";
import { messageName } from "./messages.js";
import {
  decodeHeader,
  decodeMessage,
  describeMessage,
  HEADER_SIZE,
  USB_BUFFER_SIZE,
  type Message,
} from "./protocol.js";

/** MAX_URBS: bulk IN transfers kept in flight so TS data is not lost between reads. */
export const DEFAULT_PENDING_READS = 10;
export interface TransportOptions {
  /** Bulk OUT deadline, as usb_bulk_msg(..., 1000). */
  timeoutMs?: number;
  pendingReads?: number;
  log?: (line: string) => void;
}
interface Waiter {
  resolve: (message: Message) => void;
  reject: (error: Error) => void;
}
export interface PendingMessage {
  message: Promise<Message>;
  /** Stop waiting; the promise then stays pending forever, so drop it. */
  cancel: () => void;
}
/**
 * Owns one claimed interface. Unlike a request/response bus, a Siano device
 * pushes control responses, indications and TS data through the same bulk IN
 * endpoint, so reads run continuously from open() until close().
 */
export class WebUsbTransport {
  private stopped = false;
  private closing?: Promise<void>;
  private readonly waiters = new Map<number, Waiter[]>();
  private readonly pending: Promise<{ status: string; data?: DataView }>[] = [];
  /** Messages nobody is waiting for: TS data, indications, unsolicited responses. */
  onMessage?: (message: Message) => void;
  /** Reader failure that ended the session. */
  onError?: (error: Error) => void;
  /** Transfers dropped for smsusb_onresponse()'s "invalid response" reasons. */
  invalidTransfers = 0;
  private constructor(
    readonly device: UsbDevice,
    readonly interfaceNumber: number,
    private readonly inEndpoint: number,
    private readonly outEndpoint: number,
    /** usb_endpoint_maxp(in) - sizeof(struct sms_msg_hdr) */
    readonly responseAlignment: number,
    readonly timeoutMs: number,
    private readonly log?: (line: string) => void,
  ) {}

  static async open(
    device: UsbDevice,
    options: TransportOptions = {},
  ): Promise<WebUsbTransport> {
    const timeoutMs = options.timeoutMs ?? 1000;
    const pendingReads = options.pendingReads ?? DEFAULT_PENDING_READS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new RangeError("Invalid USB timeout");
    if (!Number.isInteger(pendingReads) || pendingReads < 1)
      throw new RangeError("Invalid pending read count");
    // Do not take ownership of another session's open handle.
    if (device.opened) throw new Error("USB device is already open");
    await device.open();
    try {
      // smsusb_probe(): the board's interface, alternate setting 0, one bulk IN and one bulk OUT.
      const bulk = (a: { endpoints: readonly UsbEndpoint[] }, dir: string) =>
        a.endpoints.find((e) => e.direction === dir && e.type === "bulk");
      const match = device.configurations
        .flatMap((c) =>
          c.interfaces.map((i) => ({
            c,
            i,
            a: i.alternates.find((a) => a.alternateSetting === 0),
          })),
        )
        .map(({ c, i, a }) => ({
          c,
          i,
          a,
          inEp: a && bulk(a, "in"),
          outEp: a && bulk(a, "out"),
        }))
        .find((m) => m.a && m.inEp && m.outEp);
      if (!match?.a || !match.inEp || !match.outEp)
        throw new Error("Siano bulk IN/OUT endpoints were not found");
      const align = match.inEp.packetSize - HEADER_SIZE;
      if (align < 0) throw new Error("Bulk IN packet size is too small");
      if (
        device.configuration?.configurationValue !== match.c.configurationValue
      ) {
        await device.selectConfiguration(match.c.configurationValue);
      }
      await device.claimInterface(match.i.interfaceNumber);
      if (match.i.alternates.length > 1)
        await device.selectAlternateInterface(match.i.interfaceNumber, 0);
      // usb_clear_halt() on every endpoint; its result is ignored upstream too.
      for (const ep of [match.inEp, match.outEp])
        await device
          .clearHalt(ep.direction, ep.endpointNumber)
          .catch(() => undefined);
      const transport = new WebUsbTransport(
        device,
        match.i.interfaceNumber,
        match.inEp.endpointNumber,
        match.outEp.endpointNumber,
        align,
        timeoutMs,
        options.log,
      );
      transport.log?.(
        `in_ep = ${match.inEp.endpointNumber.toString(16)}, out_ep = ${match.outEp.endpointNumber.toString(16)}`,
      );
      void transport.readLoop(pendingReads);
      return transport;
    } catch (error) {
      await device.close().catch(() => undefined);
      throw error;
    }
  }
  get closed(): boolean {
    return this.stopped;
  }
  private assertOpen(): void {
    if (this.stopped || !this.device.opened)
      throw new Error("USB session is closed; reconnect the device");
  }
  private fail(error: Error): void {
    if (this.stopped) return;
    void this.close().catch(() => undefined);
    this.onError?.(error);
  }
  /** smsusb_start_streaming()/smsusb_onresponse(): keep transfers queued, process completions in submission order. */
  private async readLoop(count: number): Promise<void> {
    const submit = () => {
      const transfer = this.device.transferIn(this.inEndpoint, USB_BUFFER_SIZE);
      transfer.catch(() => undefined); // observed in order below; avoid unhandled rejections after close
      this.pending.push(transfer);
    };
    let failures = 0;
    try {
      for (let i = 0; i < count; i++) submit();
      while (!this.stopped) {
        const result = await this.pending.shift()!;
        if (this.stopped) return;
        if (result.status === "ok" && result.data) {
          failures = 0;
          this.dispatch(
            new Uint8Array(
              result.data.buffer,
              result.data.byteOffset,
              result.data.byteLength,
            ),
          );
        } else {
          // The kernel logs "error, urb status" and resubmits; a wedged pipe must not spin forever.
          this.log?.(`error, transfer status ${result.status}`);
          if (result.status === "stall")
            await this.device
              .clearHalt("in", this.inEndpoint)
              .catch(() => undefined);
          if (++failures >= 10)
            throw new Error(`Bulk IN failed repeatedly (${result.status})`);
        }
        submit();
      }
    } catch (error) {
      if (!this.stopped)
        this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }
  private dispatch(bytes: Uint8Array): void {
    const message = decodeMessage(bytes, this.responseAlignment);
    if (!message) {
      this.invalidTransfers++;
      this.log?.(
        `invalid response msglen ${bytes.length >= HEADER_SIZE ? decodeHeader(bytes).length : "?"} actual ${bytes.length}`,
      );
      return;
    }
    this.log?.(`received ${describeMessage(message)}`);
    const waiter = this.waiters.get(message.type)?.shift();
    if (waiter) waiter.resolve(message);
    else this.onMessage?.(message);
  }
  /** smsusb_sendrequest(): one bulk OUT transfer per message. */
  async send(message: Uint8Array): Promise<void> {
    this.assertOpen();
    const header = decodeHeader(message);
    if (header.length !== message.length)
      throw new RangeError("Message length field does not match buffer");
    this.log?.(`sending ${describeMessage(header)}`);
    const data = message.slice();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const sent = await Promise.race([
        this.device.transferOut(this.outEndpoint, data),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("USB bulk OUT timed out")),
            this.timeoutMs,
          );
        }),
      ]);
      if (sent.status !== "ok" || sent.bytesWritten !== data.length)
        throw new Error("USB bulk OUT failed or was short");
    } catch (error) {
      // WebUSB cannot cancel a transfer; a stuck OUT pipe poisons the whole session.
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  /** wait_for_completion_timeout(): the next message of the given type, or an error after timeoutMs. */
  waitFor(type: number, timeoutMs: number): PendingMessage {
    this.assertOpen();
    let waiter!: Waiter;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const queue = this.waiters.get(type) ?? [];
    this.waiters.set(type, queue);
    const cancel = () => {
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      if (timer !== undefined) clearTimeout(timer);
    };
    const message = new Promise<Message>((resolve, reject) => {
      waiter = { resolve, reject };
      timer = setTimeout(() => {
        cancel();
        reject(new Error(`Timed out waiting for ${messageName(type)}`));
      }, timeoutMs);
    });
    message.then(cancel, cancel);
    queue.push(waiter);
    return { message, cancel };
  }
  /** smscore_sendrequest_and_wait(): the waiter is armed before sending so a fast reply is never missed. */
  async request(
    message: Uint8Array,
    responseType: number,
    timeoutMs: number,
  ): Promise<Message> {
    const reply = this.waitFor(responseType, timeoutMs);
    try {
      await this.send(message);
    } catch (error) {
      reply.cancel();
      reply.message.catch(() => undefined);
      throw error;
    }
    return reply.message;
  }
  /** Idempotent. close(), rather than releaseInterface(), also cancels the reads in flight (usb_kill_urb). */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    const error = new Error("USB session closed");
    for (const queue of this.waiters.values())
      for (const waiter of queue.splice(0)) waiter.reject(error);
    this.closing = this.device.close();
    return this.closing;
  }
}
