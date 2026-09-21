# Source and modifications

This is a TypeScript/WebUSB port of:

- https://github.com/otya128/BonD_FSUSB2i_Card
- Source revision: e28bc8b6fda78ded3a17c99b8b8e5363049db539
- Original fsusb2i driver: (c) 2015–2016 trinity19683
- Original readMe.txt describes the source as based on GPLv3. The GPL version 3 license text is preserved in LICENSE.
- The fork's card implementation in it9175.c / BonDriver/scard.cpp is used as the basis for the card reader port.

Modifications (2026-09-21): replaced Windows/WinUSB and thread/DLL interfaces with TypeScript, WebUSB, serialized asynchronous operations and an async TS iterator; ported tuner initialization, calibration, tuning, statistics, TMCC and smart-card operations; added bounds checks, response validation, cancellation/timeout handling, a browser demonstration and mock/C-reference tests. All implementation code is TypeScript; Python tools only regenerate data and C reference fixtures during development.

Firmware in src/firmware-data.ts is copied byte-for-byte from it9175_fw.h (the upstream symbol is spelled it9179_fw1). The original firmware notice is:

    IT9175 firmware
    it9175_fw.h
    2015-12-06
    original: IT9175 BDA Driver for USB Device
    Copyright (C) 2013 ITE Technologies, Inc.
    IT9175BDA.sys
    2013-02-27

This notice preserves the upstream attribution and does not assert additional rights in the embedded third-party firmware.

# Third-party components used by the demonstration page

- [mpegts.js](https://github.com/xqq/mpegts.js) (Apache License 2.0, Copyright (C) Bilibili / magicxqq) is used by the browser demonstration (demo/, bundled into demo-dist/) to play the 1seg program via Media Source Extensions. It is not part of the driver library in src/.
