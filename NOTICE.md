# Source and modifications

This is a TypeScript/WebUSB port of the Siano SMS1xxx/SMS2xxx drivers in the Linux kernel:

- `drivers/media/usb/siano/smsusb.c` — Copyright (C) 2005-2009, Uri Shkolnik, Anatoly Greenblat (Siano Mobile Silicon, Inc.), GPL-2.0-or-later
- `drivers/media/common/siano/smscoreapi.c`, `smscoreapi.h` — Copyright (C) 2006-2008, Uri Shkolnik, Anatoly Greenblat, GPL-2.0-or-later
- `drivers/media/common/siano/smsdvb-main.c`, `smsdvb.h`, `smsendian.c` — Copyright (C) 2006-2009, Uri Shkolnik, GPL-2.0-or-later
- `drivers/media/mmc/siano/smssdio.c` — Copyright (C) 2008 Pierre Ossman, GPL-2.0-or-later (consulted for the message/split-message framing only)
- `drivers/media/common/siano/sms-cards.c`, `sms-cards.h` — Copyright (c) 2008 Michael Krufky, GPL-2.0-only; only the factual USB ID / board type / default mode entries for `SMS1XXX_BOARD_SIANO_RIO` were used, no code
- Source revision: Linux 7.3-rc4 (93f51579e7df248780214094418f205253383cc5)

The GPL-2.0-or-later sources are used here under GPL version 3, so the whole project stays under the GPL-3.0-only terms in LICENSE.

Mapping of the port (2026-09-21):

- `src/messages.ts` — `enum msg_types`, device modes, bandwidth modes, task ids from `smscoreapi.h`
- `src/protocol.ts` — `struct sms_msg_hdr` framing and the split-message realignment of `smsusb_onresponse()`
- `src/transport.ts` — `smsusb.c`: interface/endpoint selection, `MAX_URBS` queued bulk IN reads, `smsusb_sendrequest()`, completion-style waiting (`smscore_sendrequest_and_wait()`)
- `src/firmware.ts`, `src/core.ts` — `smscoreapi.c`: `smscore_detect_mode()`, `smscore_set_device_mode()`, `smscore_load_firmware_family2()`, `smscore_init_device()`, `smscore_configure_board()`
- `src/isdbt.ts` — `smsdvb-main.c`: `smsdvb_isdbt_set_frontend()`, PID filters, `smsdvb_send_statistics_request()`, `struct sms_isdbt_stats(_ex)` decoding, lock indications

Deliberate differences from the kernel:

- Firmware is not looked up from `/lib/firmware`; the caller passes the image (`isdbt_rio.inp`). Exactly `length` bytes of the image payload are sent, while the kernel sends `fw->size` bytes from the payload and therefore 12 bytes past the end of the file.
- After a firmware download `MSG_SMS_GET_VERSION_EX_REQ` is sent again so the reported ids describe the running firmware.
- There is no DVB demux: `stream()` adds PID filters (0x2000 by default) and hands out the raw `MSG_SMS_DVBT_BDA_DATA` payloads realigned to 188-byte packets. A slow consumer drops data instead of stalling the USB reads, which the control channel shares.
- IR, GPIO/LED, LNA and board-specific hooks are omitted; Rio has none in `sms_boards`.

No firmware is included. `isdbt_rio.inp` is proprietary Siano firmware and must be supplied by the user.

# Third-party components used by the demonstration page

- [mpegts.js](https://github.com/xqq/mpegts.js) (Apache License 2.0, Copyright (C) Bilibili / magicxqq) is used by the browser demonstration (demo/, bundled into demo-dist/) to play the 1seg program via Media Source Extensions. It is not part of the driver library in src/.
