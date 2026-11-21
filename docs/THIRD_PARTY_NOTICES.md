# Third-party notices

## Voltide (MIT)

Copyright (c) 2026 Joko

Parts of this plugin are derived from the Voltide project
(https://github.com/sdparklab/Voltide), which is distributed under
the MIT License:

- `adapters/compx-17b.js` — Compx 17-byte battery protocol (Report ID `0x08`,
  opcode `0x04`, checksum 0x4D over the 16-byte payload), verified by Voltide on
  ATK A9 Air (373B:1278) and IMECOO P1 (3554:FB34).
- `adapters/mchose-20b.js` — MCHOSE 20-byte frame (Report ID `0x13`, command
  `0x4A`), used for the 3554:FA09 / 258A:01BB devices documented by Voltide.
- `rust/src/bin/cli.rs` — XInput four-notch battery mapping (full=100,
  medium=50, low=20, empty=5; wired = 100% charging) follows Voltide's
  `XInputProvider`.
- `adapters/logitech-hidpp.js` — HID++ 2.0 feature discovery (0x1000 / 0x1004),
  receiver slot scan, and the strict reply-matching rule follow Voltide's
  `LogitechProvider`. The adapter is experimental and was not tested on this
  machine.
- `adapters/rapoo-vt3s.js`, `adapters/dualsense.js`, `adapters/mchose-v9.js`,
  `adapters/xiberia-t7.js`, `adapters/crociris-x7.js` — protocols transcribed
  from Voltide's `RapooProvider`, `DualSenseProvider`,
  `MchoseV9HeadsetProvider`, `XiberiaT7Provider`, and `X7MouseProvider`
  respectively. All are experimental and were not tested on this machine.
- `adapters/compx-17b.js` also covers DAREU A950 AIR V2, whose checksum variant
  and frame layout come from Voltide's `DareuA950MouseProvider`.
- `protocols/catalog.js` — protocol summaries and detection hints for the
  families above, plus EWEADN, MCHOSE A7 Ultra, ATK N9 V2, ROG, and Razer.
- The `Discover(catalog)` / `Read(device)` provider split and the
  "enumerate once per refresh" design informed the adapter architecture
  comparison in `docs/IMPLEMENTATION.md`.

No Voltide source code was copied verbatim; the protocol rules and design
patterns were reimplemented for this plugin. Devices borrowed from Voltide have
not necessarily been verified on this machine — see the notes in each adapter.

## BatteryHub (GPLv3) — protocol research only

[Wireless-Device-Battery-Monitor / BatteryHub](https://github.com/krisgfx9/Wireless-Device-Battery-Monitor)
is a GPLv3 project used as a protocol-research reference for device families,
PIDs and report semantics. **No BatteryHub source code is copied or linked into
this plugin.** The implementations in `adapters/` and `rust/` are independent
rewrites. If that ever changes, the distributed derivative must be evaluated
under GPLv3 before release.

## Voltide MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
