import mpegts from "mpegts.js";
export interface PushPlayer {
  /** Feed 188-byte aligned MPEG-TS packets of a single program. */
  push(packets: Uint8Array<ArrayBuffer>): void;
  destroy(): void;
}
export const isPlaybackSupported = (): boolean => mpegts.isSupported();
/** mpegts.js MSE player fed from memory instead of a URL. */
export function createPushPlayer(
  video: HTMLVideoElement,
  onMessage: (message: string) => void,
): PushPlayer {
  let sink: ((chunk: ArrayBuffer) => void) | undefined;
  class PushLoader extends mpegts.BaseLoader {
    private received = 0;
    constructor() {
      super("fsusb2i-push-loader");
      this._needStash = false;
    }
    open() {
      this._status = mpegts.LoaderStatus.kBuffering;
      sink = (chunk) => {
        const start = this.received;
        this.received += chunk.byteLength;
        this.onDataArrival?.(chunk, start, this.received);
      };
    }
    abort() {
      sink = undefined;
      this._status = mpegts.LoaderStatus.kComplete;
    }
    destroy() {
      this.abort();
      super.destroy();
    }
  }
  const player = mpegts.createPlayer(
    { type: "mpegts", isLive: true, url: "webusb://fsusb2i/oneseg" },
    {
      customLoader: PushLoader,
      enableStashBuffer: false,
      lazyLoad: false,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 3,
      liveBufferLatencyMinRemain: 1,
    },
  );
  player.on(
    mpegts.Events.ERROR,
    (type: string, detail: string, info?: { msg?: string }) =>
      onMessage(
        `再生エラー: ${type} / ${detail}${info?.msg ? ` / ${info.msg}` : ""}`,
      ),
  );
  player.on(mpegts.Events.MEDIA_INFO, (info: Record<string, unknown>) => {
    const { width, height, fps, videoCodec, audioCodec } = info;
    onMessage(
      `メディア情報: ${width}x${height} ${fps ?? "?"}fps ${videoCodec ?? "-"} / ${audioCodec ?? "-"}`,
    );
  });
  player.attachMediaElement(video);
  player.load();
  void Promise.resolve(player.play()).catch((error: unknown) =>
    onMessage(
      `再生開始に失敗: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
  return {
    push: (packets) =>
      sink?.(
        packets.byteOffset === 0 &&
          packets.byteLength === packets.buffer.byteLength
          ? packets.buffer
          : packets.slice().buffer,
      ),
    destroy: () => {
      sink = undefined;
      player.pause();
      player.unload();
      player.detachMediaElement();
      player.destroy();
    },
  };
}
