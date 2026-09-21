import { Fsusb2i, OneSegFilter, type TsProgram } from "../src/index.js";
import {
  createPushPlayer,
  isPlaybackSupported,
  type PushPlayer,
} from "./player.js";
const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const button = (id: string) => element<HTMLButtonElement>(id);
const output = (id: string, value: unknown) => {
  element(id).textContent =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
};
const hex = (bytes: Uint8Array) =>
  [...bytes]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ")
    .toUpperCase();
const RECORD_LIMIT = 64 * 1024 * 1024;
let device: Fsusb2i | undefined,
  busy = false,
  receiving = false,
  controller: AbortController | undefined,
  recorder: { chunks: Uint8Array<ArrayBuffer>[]; length: number } | undefined,
  player: PushPlayer | undefined,
  filter: OneSegFilter | undefined,
  programs: readonly TsProgram[] = [],
  downloadUrl: string | undefined;
function log(message: string) {
  const lines = `${new Date().toLocaleTimeString()} ${message}\n${element("log").textContent}`;
  output("log", lines.split("\n").slice(0, 100).join("\n"));
}
function refresh() {
  const connected = !!device && !device.closed;
  button("connect").disabled =
    busy || receiving || connected || !("usb" in navigator);
  button("disconnect").disabled = !connected || busy || receiving;
  for (const id of ["tune", "stats", "card-reset", "send", "receive"])
    button(id).disabled = !connected || busy || receiving;
  button("receive-stop").disabled = !receiving;
  button("record").disabled = !receiving || !!recorder;
  button("stop").disabled = !recorder;
  button("play").disabled = !receiving || !!player || !isPlaybackSupported();
  button("play-stop").disabled = !player;
  output(
    "status",
    busy ? "処理中…" : receiving ? "受信中" : connected ? "接続済み" : "未接続",
  );
}
async function action(operation: () => Promise<void>) {
  busy = true;
  refresh();
  try {
    await operation();
  } catch (error) {
    log(`エラー: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    busy = false;
    refresh();
  }
}
button("connect").onclick = () => {
  // Start the chooser synchronously in this click's user activation.
  const pending = Fsusb2i.request();
  void action(async () => {
    device = await pending;
    output("device-info", {
      name: device.device.productName,
      vid: device.device.vendorId.toString(16),
      pid: device.device.productId.toString(16),
      ...device.info,
    });
    log("初期化完了");
  });
};
button("disconnect").onclick = () =>
  void action(async () => {
    await device?.close();
    device = undefined;
    log("切断しました");
  });
button("tune").onclick = () =>
  void action(async () => {
    await device!.setChannel(
      Number(element<HTMLInputElement>("channel").value),
    );
    const tuning = await device!.waitTuning();
    output("statistics", {
      tuning,
      stream:
        tuning.status === "locked" ? await device!.waitStream() : undefined,
    });
    log(`選局結果: ${tuning.status}`);
  });
button("stats").onclick = () =>
  void action(async () =>
    output("statistics", {
      statistics: await device!.readStatistics(),
      tmcc: await device!.readTmcc(),
    }),
  );
button("card-reset").onclick = () =>
  void action(async () =>
    output("card-output", `ATR: ${hex(await device!.resetCard())}`),
  );
button("send").onclick = () =>
  void action(async () => {
    const value = element<HTMLInputElement>("apdu").value.replace(/\s+/g, "");
    if (!/^(?:[0-9a-fA-F]{2}){1,53}$/.test(value))
      throw new Error("1〜53 bytes の16進数を入力してください");
    const data = Uint8Array.from(value.match(/../g)!, (byte) =>
      parseInt(byte, 16),
    );
    output("card-output", `Response: ${hex(await device!.transmitCard(data))}`);
  });
// --- TS reception: one USB stream shared by the recorder and the player ---
button("receive").onclick = () => {
  if (!device || receiving) return;
  const source = device;
  controller = new AbortController();
  receiving = true;
  refresh();
  const signal = controller.signal;
  let length = 0;
  void (async () => {
    try {
      if (!(await source.waitStream()).locked)
        throw new Error("TS 同期がありません。先に選局してください");
      for await (const chunk of source.stream({ signal })) {
        length += chunk.length;
        output("bytes", `${length.toLocaleString()} bytes`);
        if (recorder) {
          recorder.chunks.push(chunk);
          recorder.length += chunk.length;
          if (recorder.length >= RECORD_LIMIT) {
            log("録画サイズの上限に達しました");
            stopRecording();
          }
        }
        if (player && filter) {
          const packets = filter.push(chunk);
          if (packets.length) player.push(packets);
        }
      }
      log(`受信停止: ${length.toLocaleString()} bytes`);
    } catch (error) {
      log(
        `受信エラー: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      stopRecording();
      stopPlayback();
      receiving = false;
      controller = undefined;
      refresh();
    }
  })();
};
button("receive-stop").onclick = () => controller?.abort();
// --- Recording ---
button("record").onclick = () => {
  if (!receiving || recorder) return;
  recorder = { chunks: [], length: 0 };
  element("download").hidden = true;
  log("録画開始");
  refresh();
};
function stopRecording() {
  if (!recorder) return;
  const { chunks, length } = recorder;
  recorder = undefined;
  if (chunks.length) {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(new Blob(chunks, { type: "video/mp2t" }));
    const link = element<HTMLAnchorElement>("download");
    link.href = downloadUrl;
    link.download = `fsusb2i-${Date.now()}.ts`;
    link.hidden = false;
  }
  log(`録画停止: ${length.toLocaleString()} bytes`);
  refresh();
}
button("stop").onclick = stopRecording;
// --- 1seg playback ---
const service = element<HTMLSelectElement>("service");
function showPrograms(list: readonly TsProgram[]) {
  programs = list;
  const current = service.value;
  for (const option of [...service.options].slice(1)) option.remove();
  for (const program of list) {
    const option = document.createElement("option");
    option.value = String(program.programNumber);
    option.textContent = `0x${program.programNumber.toString(16).padStart(4, "0")} (PMT 0x${program.pmtPid.toString(16).padStart(4, "0")}${program.partialReception ? "、ワンセグ" : ""})`;
    service.append(option);
  }
  service.value = current;
  if (service.value !== current) service.value = "";
  output("player-info", {
    programs: list,
    selected: filter?.program,
  });
}
function startPlayback() {
  if (!receiving || player) return;
  if (!isPlaybackSupported()) {
    log("このブラウザーは MSE の H.264 再生に対応していません");
    return;
  }
  filter = new OneSegFilter({
    programNumber: service.value ? Number(service.value) : undefined,
  });
  filter.onPrograms = showPrograms;
  player = createPushPlayer(element<HTMLVideoElement>("video"), log);
  log("ワンセグ再生開始");
  refresh();
}
function stopPlayback() {
  if (!player) return;
  player.destroy();
  player = undefined;
  filter = undefined;
  log("ワンセグ再生停止");
  refresh();
}
button("play").onclick = startPlayback;
button("play-stop").onclick = stopPlayback;
service.onchange = () => {
  // Restart so mpegts.js re-initialises for the new program's codecs and timestamps.
  if (!player) return;
  stopPlayback();
  startPlayback();
  showPrograms(programs);
};
const usb = (navigator as Navigator & { usb?: EventTarget }).usb;
usb?.addEventListener("disconnect", () => {
  if (device?.closed) {
    log("USB デバイスが切断されました");
    refresh();
  }
});
if (!usb) log("このブラウザーは WebUSB に対応していません。");
if (!isPlaybackSupported())
  log("このブラウザーは MSE の H.264 再生に対応していません。");
refresh();
