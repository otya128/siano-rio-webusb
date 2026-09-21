import { Fsusb2i } from "../src/index.js";
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
let device: Fsusb2i | undefined,
  busy = false,
  recording = false,
  controller: AbortController | undefined,
  downloadUrl: string | undefined;
function log(message: string) {
  const lines = `${new Date().toLocaleTimeString()} ${message}\n${element("log").textContent}`;
  output("log", lines.split("\n").slice(0, 100).join("\n"));
}
function refresh() {
  const connected = !!device && !device.closed;
  button("connect").disabled =
    busy || recording || connected || !("usb" in navigator);
  button("disconnect").disabled = !connected || busy || recording;
  for (const id of ["tune", "stats", "card-reset", "send", "record"])
    button(id).disabled = !connected || busy || recording;
  button("stop").disabled = !recording;
  output(
    "status",
    busy ? "処理中…" : recording ? "受信中" : connected ? "接続済み" : "未接続",
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
button("record").onclick = () => {
  if (!device || recording) return;
  const source = device;
  controller = new AbortController();
  recording = true;
  refresh();
  const signal = controller.signal;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  element("download").hidden = true;
  void (async () => {
    try {
      if (!(await source.waitStream()).locked)
        throw new Error("TS 同期がありません。先に選局してください");
      for await (const chunk of source.stream({ signal })) {
        chunks.push(chunk);
        length += chunk.length;
        output("bytes", `${length.toLocaleString()} bytes`);
        if (length >= 64 * 1024 * 1024) break;
      }
      log(`録画停止: ${length.toLocaleString()} bytes`);
    } catch (error) {
      log(
        `録画エラー: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (chunks.length) {
        if (downloadUrl) URL.revokeObjectURL(downloadUrl);
        downloadUrl = URL.createObjectURL(
          new Blob(chunks, { type: "video/mp2t" }),
        );
        const link = element<HTMLAnchorElement>("download");
        link.href = downloadUrl;
        link.download = `fsusb2i-${Date.now()}.ts`;
        link.hidden = false;
      }
      recording = false;
      controller = undefined;
      refresh();
    }
  })();
};
button("stop").onclick = () => controller?.abort();
const usb = (navigator as Navigator & { usb?: EventTarget }).usb;
usb?.addEventListener("disconnect", () => {
  if (device?.closed) {
    log("USB デバイスが切断されました");
    refresh();
  }
});
if (!usb) log("このブラウザーは WebUSB に対応していません。");
refresh();
