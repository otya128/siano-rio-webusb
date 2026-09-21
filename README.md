# FSUSB2i WebUSB

`BonD_FSUSB2i_Card` をベースにした、TypeScript 製の FSUSB2i / IT9175 ドライバーです。WebUSB からチューナーと内蔵カードリーダーを制御します。Windows DLL の代わりに、ブラウザー用の非同期 API と操作画面を提供します。

## 起動

Node.js 20.19 以降（22 系は 22.12 以降）を使用します。

```sh
npm ci
npm run dev
```

[操作画面](http://127.0.0.1:5173/)を WebUSB 対応ブラウザー（Chrome / Edge など）で開き、「USB デバイスを選択」から FSUSB2i を選びます。初期化後、選局、受信状態取得、TS 録画、カード初期化、APDU 送信を実行できます。録画停止後に表示されるリンクから TS を保存します。

WebUSB は HTTPS または localhost の安全なコンテキストと、デバイス選択時のユーザー操作を必要とします。Windows では対象インターフェースに WinUSB ドライバーが必要です。Linux では USB デバイスへのアクセス権限が必要になる場合があります。他のアプリや OS ドライバーが占有している場合は claim に失敗します。[Chrome の WebUSB ドキュメント](https://developer.chrome.com/docs/capabilities/usb)を参照してください。

元実装は Windows のドライバー GUID で列挙しており VID/PID を指定していません。そのため、この実装も固定の VID/PID を仮定せず、選択後に bulk OUT 2 / IN 1 / IN 4 とチップ ID `0x91758301` を確認します。API 利用時は `filters` に手元の機器の VID/PID を設定できます。

## 移植範囲

| 元実装                  | TypeScript                                                                     |
| ----------------------- | ------------------------------------------------------------------------------ |
| `it9175_usb.c`, WinUSB  | WebUSB bulk 通信、チェックサム、応答長・シーケンス検証、直列化                 |
| `it9175.c` 初期化       | チップ確認、EEPROM、ファームウェア転送・起動、チューナー・復調器・USB 初期化   |
| 周波数設定              | 53,000〜859,999 kHz、6 MHz 帯域、UHF 13〜62ch、校正値による分周境界            |
| 受信監視                | 選局結果、TS ロック、オーバーフロー、TMCC、信号品質・強度・S/N・各層エラー統計 |
| `tsthread.c`            | AsyncGenerator による TS bulk 受信、188 byte パケット再同期                    |
| カード処理、`scard.cpp` | カード検出・リセット・ATR・IFS・T=1 APDU 送受信                                |
| 終了処理                | チューナーの省電力化、インターフェース解放、USB close                          |

BonDriver DLL / PC/SC ABI 自体の互換レイヤーではありません。TS の復号、映像・音声デコード、ブラウザー内再生は含みません。

## API

```ts
import { Fsusb2i } from "./src/index.js";

// ボタンの click ハンドラーから直接呼び出す
const tuner = await Fsusb2i.request();
console.log(tuner.info);
await tuner.setChannel(13); // 473143 kHz
// 任意周波数: await tuner.setFrequency(473143);
console.log(await tuner.waitTuning(1500));
console.log(await tuner.waitStream(1500));
console.log(await tuner.readStatistics());
console.log(await tuner.readTmcc());

const atr = await tuner.resetCard();
// const response = await tuner.transmitCard(apduBytes);
// response は NAD / PCB / LEN / LRC を取り除いた APDU 応答（SW1/SW2 を含む）

const stop = new AbortController();
// 停止ボタンから stop.abort() を呼ぶ
try {
  for await (const ts of tuner.stream({
    signal: stop.signal,
    timeoutMs: 5000,
  })) {
    // ts は 188 byte の整数倍。保存先にすばやく渡す。
    console.log(ts.byteLength);
  }
} finally {
  await tuner.close();
}
```

- `Fsusb2i.open(usbDevice, options)` で許可済みの `USBDevice` を渡せます。`browserUsb().getDevices()` は許可済み機器を取得します。
- `request({ filters, timeoutMs, firmware })` / `open(device, { timeoutMs, firmware })` にオプションを渡せます。通常のUSBコマンドのタイムアウトは 1000 ms、TS は 5000 ms です。`firmware` は元の `it9179_fw1` バンク形式で、未起動の機器にのみ転送します。
- 制御操作は高水準の操作単位で直列化します。同じ接続への並列 APDU 送信も混線しません。TS の読み手は一つだけです。受信中の選局は拒否します。
- `close()` は冪等です。通常は省電力化して解放します。TS 受信中は保留中の転送を止めるため直接 USB を閉じます。
- WebUSB に転送単位のキャンセルがないため、**TS の終了・中断、および USB 通信失敗・タイムアウトは接続全体を閉じます**。再利用するときは新たに `request()` / `open()` してください。保留中の `next()` を止めるには AbortSignal または `close()` を使用します。
- TS は pull 型で、消費側が遅いと機器側バッファが溢れる可能性があります。`waitStream()` の overflow 情報で検出できます。初期同期には3つの同期バイトを使用するため、ごく短いデータと終了時の端数は返しません。画面の録画はメモリー使用量を約64 MiB（最大1チャンク超過）に制限しています。
- APDU 送信は **1〜53 bytes** の単一 I-block に限定します。USB 64 byte 上限から算出した安全な長さです。受信は最大254 byteの情報フィールドを扱います。T=1 chaining / R-block 再送 / WTX は元実装にも処理がなく、この移植では未対応としてエラーにします。失敗後は次の送信時にカードを再初期化します。
- `readTmcc()` の modulation / codeRate は元実装と同じ数値コードです。予約値は modulation=4 / codeRate=5 にまとめます。未使用層は segments=0 です。

## ビルドと検証

```sh
npm test            # TypeScript ビルド + Node.js モックテスト
npm run typecheck   # ライブラリーと操作画面の型検査
npm run build       # dist/ に ESM と型定義を出力
npm run build:demo  # demo-dist/ に静的画面を出力
```

テストは USB パケット、直列化・シーケンス周回、破損応答、タイムアウト、cold/warm 初期化、カード通信、TS 分割・再同期・中断を検証します。さらに元 C の関数を実際にコンパイルして得た参照データと、初期化および10周波数での全レジスター書き込みを3つのクロックモードで比較しています。

**実機での受信・カード応答・連続転送性能は未検証です。** 操作画面はブラウザーで表示を確認しています。実機では cold boot と再接続、放送波のあるチャンネルで TS ロック・録画、カード ATR と APDU 応答、抜き差しを確認してください。

元リポジトリは実行時には不要です。取り込みデータと C 参照データを再生成する場合のみ使用します。

```sh
python3 tools/import-tables.py ../BonD_FSUSB2i_Card/src
python3 tools/reference-trace.py ../BonD_FSUSB2i_Card/src # C コンパイラーが必要
npm test
```

## ライセンスと由来

GPL-3.0-only。元実装の著作権表示、取り込んだファームウェアの由来、変更内容は [NOTICE.md](NOTICE.md)、ライセンス全文は [LICENSE](LICENSE) に記載しています。
