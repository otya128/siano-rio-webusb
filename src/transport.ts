import type { UsbDevice } from "./usb.js";
import {
  Command,
  decodeResponse,
  encodeRequest,
  SerialQueue,
  TS_TRANSFER_SIZE,
} from "./protocol.js";

/** Owns one claimed device. A failed exchange poisons the session to avoid stale ACKs. */
export class WebUsbTransport {
  private readonly queue = new SerialQueue();
  private sequence = 0;
  private stopped = false;
  private closing?: Promise<void>;
  private constructor(
    readonly device: UsbDevice,
    private readonly interfaceNumber: number,
    readonly timeoutMs: number,
  ) {}

  static async open(
    device: UsbDevice,
    timeoutMs = 1000,
  ): Promise<WebUsbTransport> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new RangeError("Invalid USB timeout");
    // Do not take ownership of another session's open handle.
    if (device.opened) throw new Error("USB device is already open");
    await device.open();
    try {
      const matches = device.configurations.flatMap((c) =>
        c.interfaces.flatMap((i) =>
          i.alternates
            .filter((a) =>
              [
                [2, "out"],
                [1, "in"],
                [4, "in"],
              ].every(([ep, dir]) =>
                a.endpoints.some(
                  (e) =>
                    e.endpointNumber === ep &&
                    e.direction === dir &&
                    e.type === "bulk",
                ),
              ),
            )
            .map((a) => ({ c, i, a })),
        ),
      );
      const match = matches[0];
      if (!match)
        throw new Error(
          "IT9175 bulk endpoints 0x02, 0x81 and 0x84 were not found",
        );
      if (
        device.configuration?.configurationValue !== match.c.configurationValue
      ) {
        await device.selectConfiguration(match.c.configurationValue);
      }
      await device.claimInterface(match.i.interfaceNumber);
      await device.selectAlternateInterface(
        match.i.interfaceNumber,
        match.a.alternateSetting,
      );
      return new WebUsbTransport(device, match.i.interfaceNumber, timeoutMs);
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
  /** WebUSB has no per-transfer cancellation. Timeout closes the entire session. */
  private async bounded<T>(
    operation: () => Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    this.assertOpen();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void this.close().catch(() => undefined);
            reject(new Error("USB transfer timed out; session closed"));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  command(
    command: number,
    mailbox = 0,
    payload = new Uint8Array(0),
    readLength = 0,
  ): Promise<Uint8Array> {
    if (!Number.isInteger(readLength) || readLength < 0 || readLength > 59)
      return Promise.reject(new RangeError("Invalid response length"));
    // Validate and snapshot before entering the queue; callers may reuse their buffers.
    const requestPayload = payload.slice();
    if (requestPayload.length > 58)
      return Promise.reject(
        new RangeError("USB command payload exceeds 58 bytes"),
      );
    return this.queue.run(async () => {
      this.assertOpen();
      const sequence = this.sequence++ & 255;
      const request = encodeRequest(command, mailbox, sequence, requestPayload);
      try {
        return await this.bounded(async () => {
          const sent = await this.device.transferOut(2, request);
          if (sent.status !== "ok" || sent.bytesWritten !== request.length)
            throw new Error("USB command write failed or was short");
          if (command === Command.firmwareDownload) return new Uint8Array(0);
          const received = await this.device.transferIn(1, readLength + 5);
          if (received.status !== "ok" || !received.data)
            throw new Error("USB command read failed");
          const data = received.data;
          return decodeResponse(
            new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
            sequence,
            readLength,
          );
        }, this.timeoutMs);
      } catch (error) {
        void this.close().catch(() => undefined);
        throw error;
      }
    });
  }
  async readTs(timeoutMs = 5000): Promise<Uint8Array> {
    try {
      return await this.bounded(async () => {
        const result = await this.device.transferIn(4, TS_TRANSFER_SIZE);
        if (result.status !== "ok" || !result.data)
          throw new Error("TS bulk transfer failed");
        return new Uint8Array(
          result.data.buffer,
          result.data.byteOffset,
          result.data.byteLength,
        ).slice();
      }, timeoutMs);
    } catch (error) {
      void this.close().catch(() => undefined);
      throw error;
    }
  }
  close(): Promise<void> {
    this.stopped = true;
    // close(), rather than releaseInterface(), also cancels pending transfers.
    return (this.closing ??= this.device.close());
  }
  async release(): Promise<void> {
    if (this.stopped) return this.close();
    try {
      await this.device.releaseInterface(this.interfaceNumber);
    } finally {
      await this.close();
    }
  }
}
