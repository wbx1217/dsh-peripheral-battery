# BatteryHub ↔ 无线外设电量插件覆盖矩阵

对比对象：

- **BatteryHub**：`D:\Wireless-Device-Battery-Monitor-main`，C++/Win32，GPLv3；
  README 支持表约 **100 个厂商/设备族行**，`src/drivers/` **113 个驱动/协议文件**，
  `tests/` **60 个协议/驱动测试**。
- **本插件**：11 个出厂适配器（3 个 stable + 8 个 beta）+ 16 条协议目录条目，其中 **3 个本机真机验证**；另有 5 个 MCHOSE experimental 在市场。

状态：

| 标记 | 含义 |
|---|---|
| ✅ | 本插件有适配器，且本机真机验证过 |
| 🟡 | 有适配器，但未验证或只覆盖该族的一部分 |
| 🟠 | 只有 `protocols/catalog.js` 知识，没有可直接加载的适配器；`needs-capture` 也算这一档 |
| ❌ | 当前插件没有覆盖 |
| ➕ | 本插件有，BatteryHub 没有对应行（插件独有） |

BatteryHub 证据缩写：**HW** = README 标为 hardware-tested；**test** = 有驱动/协议单测；**docs** = 有协议文档；**untested** = README 明确未验证。

---

## 一、总览

| 指标 | 当前插件 | BatteryHub |
|---|---:|---:|
| 驱动/适配器文件 | 11 个 factory（3 stable + 8 beta）+ 5 个 market | 113 个 C++ 驱动 |
| 协议目录/支持族 | 16 条 | ~100 行（大量型号） |
| 本机真机验证 | 3 个 stable；8 个 beta | README 中大量 HW 条目 |
| 协议测试 | 7 个 MCHOSE 测试（市场仓库 CI） | 60 个测试 |
| 传输层 | HID + BLE + XInput | HID + BLE + 串口 + RFCOMM + Phone Link + HeadsetControl |
| 直接覆盖 | 3 个 stable；beta 按协议族扩展 | 约 100 个厂商/设备族 |

结论：**BatteryHub 的设备数据远多于本插件**。主要缺口不是“再写几个 VID/PID”，而是大量协议族、通用 HID/BLE 兜底，以及串口/RFCOMM/外部助手这些新传输层。

---

## 二、已有覆盖与半覆盖

| 设备/系列 | BatteryHub 驱动与证据 | 当前插件 | 差距/说明 | 移植 |
|---|---|---|---|---|
| DARKRIM SHADOW `3654:6901` | `darkrim.cpp` · HW + test + docs | ✅ `darkrim-shadow` | 已覆盖；BatteryHub 文档更完整（CRC/充电/粗粒度） | — |
| MCHOSE G87 `41E4:2001` | `aula.cpp` · HW | ✅ `mchose-g87` | 已覆盖 | — |
| ATK A9 Plus `373B:1115` | `kysona.cpp` · HW | ✅ `atk-a9-plus` | 已覆盖；Kysona 家族其余型号未覆盖 | JS |
| Compx 17B（ATK/VXE/IMECOO/达尔优） | `kysona.cpp` · HW/test | 🟡 `compx-17b` | 只覆盖 4 个 PID；Corsair Sabre、CHERRY XTRFY、Sharkoon、Zenith 等未覆盖 | JS |
| MCHOSE/AULA/Redragon BY 键盘 | `aula.cpp` · HW/docs | 🟡 `mchose-20b` | 只覆盖 `3554:FA09`、`258A:01BB`；AULA/Redragon 更多型号、K87 等未覆盖 | JS |
| MCHOSE V9 | `mchose_headset.cpp` · HW | 🟡 `mchose-v9` | 只覆盖 V9 Turbo+ `3837:600A`；BatteryHub 覆盖 V9 Pro 2 `3837:6011` | JS |
| MCHOSE L7/M7/A7/K7、G3 V2 | `mchose.cpp`、`mchose_modern.cpp`、`mchose_g3.cpp` · HW/test | 🟠 market `mchose-5253`、`mchose-3837-legacy`、`mchose-modern`、`mchose-g3` | 已迁到市场（experimental）；需安装，未在本插件真机验证 | JS |
| MCHOSE K87 V3 | `mchose_modern.cpp` · HW/test | 🟠 market `mchose-k87` | 已迁到市场（experimental）；G75/K99 V3 的 GLW 另属一套协议 | JS |
| Logitech HID++ | `logitech.cpp` · HW/test | 🟡 `logitech-hidpp` | 只做通用 HID++ 2.0，实验性；G435/Astro 等专用协议缺失 | JS |
| Sony DualSense / Edge | `playstation.cpp` · HW | 🟡 `sony-dualsense` | 只覆盖 DS5/Edge；DS4、INZONE 耳机/豆未覆盖 | JS |
| RAPOO VT3S | `rapoo.cpp` · test/HW | 🟡 `rapoo-vt3s` | 只覆盖 VT3S；VT3 Max、VT9、VT1 Pro Max、VT3 Pro 未覆盖 | JS |
| XIBERIA T7 | 无对应 BatteryHub 行 | ➕ `xiberia-t7` | 插件独有，未真机验证 | — |
| CROCIRIS X7 | 无对应 BatteryHub 行 | ➕ `crociris-x7` | 插件独有，未真机验证 | — |
| EWEADN S9 | `eweadn.cpp` · HW | 🟠 `eweadn-s9` | 只有协议目录，没有可直接加载的适配器 | JS |
| DAREU A950 | `dareu.cpp` · HW | 🟡 `compx-17b`（目录另有 `dareu-a950`） | 当前由 Compx 适配器覆盖 `260D:1175`；EM901X/A84/A980 未覆盖 | JS |
| Razer 91 字节 | `razer.cpp` · HW | 🟠 `razer-91` | 只有协议目录，没有 Razer 适配器文件 | JS |
| MCHOSE A7 Ultra | `mchose.cpp` · HW | 🟠 `mchose-a7-ultra` | 只有协议目录；`mchose-v9` 不是 A7 | JS |
| ASUS ROG 64B | `rog.cpp` · HW | 🟠 `asus-64` | `needs-capture`，没有可加载适配器 | JS |
| ATK N9 耳机 | `atk_serial.cpp` · HW | 🟠 `atk-n9-headset` | `needs-capture`；且需要 COM 串口 | Rust |
| MCHOSE K7/A5 | `mchose_modern.cpp`/`mchose_a5.cpp` · HW | 🟠 `mchose-k7-a5` | `needs-capture`；现代 MCHOSE 协议未实现 | JS |

> “协议目录”不等于开箱可用：`battery_protocols` 只能给 agent 线索；没有对应 `adapters/*.js` 时，用户仍读不到电量。

---

## 三、主要缺口（按设备族）

| 设备族 | BatteryHub 驱动与证据 | 当前插件 | 说明 | 移植 |
|---|---|---|---|---|
| MCHOSE A5 初代 / G75/K99 V3 / V9 Pro 2 | `mchose_a5.cpp`、`mchose_keyboard.cpp`、`mchose_headset.cpp` · HW | ❌/🟡 | A5 和 GLW 键盘未移植；G87 老 20B 已覆盖 | JS |
| MCHOSE 键盘：K87 V3、G75 V2、K99 V3、X75 | `mchose_keyboard.cpp`、`aula.cpp` · HW/test | 🟡 K87 已移植 | K87 V3 有初版；G75/K99 V3/X75 的 GLW 未覆盖；K87S 属 QHW | JS |
| ATK/VXE NK、Zero、8K Nano | `atk_bitmouse.cpp` · HW | ❌ | 373B 家族；HID 读写即可 | JS |
| ATK N9 Pro/Ultra 耳机 | `atk_serial.cpp` · HW | 🟠 | 虚拟 COM 口，不是 HID | Rust |
| Keychron 鼠标（M4/4K/8K/Nape Pro） | `keychron.cpp` · HW/test | ❌ | 多套 receiver 协议，适合先做鼠标 | JS |
| Keychron 键盘（K5 Max 等） | `keychron.cpp` · HW + 固件补丁 | ❌ | 需要键盘固件补丁；stock 固件只走蓝牙 | JS + 前置说明 |
| Logitech G435 / ASTRO A50 | `logitech_g435_0adf.cpp`、`astro.cpp` · HW | ❌ | 与通用 HID++ 不同，需要专用帧 | JS |
| Razer 耳机：BlackShark、Barracuda | `razer_headset.cpp`、`barracuda_pro.cpp` · HW | ❌ | 与 Razer 91B 鼠标协议不同 | JS |
| SteelSeries 耳机/鼠标 | `steelseries.cpp`、`steelseries_elite.cpp` · HW | ❌ | Arctis/Aerox/Prime/Rival 多协议 | JS |
| Corsair Void/HS/Bragi/Slipstream | `corsair.cpp` · HW | ❌ | Bragi GET + Compx 两种 | JS |
| HyperX Cloud/Pulsefire | `hyperx.cpp` · HW/test | ❌ | 多代耳机 + 鼠标 | JS |
| Glorious / Hitscan / G-Wolves | `glorious.cpp`、`kysona.cpp` · HW | ❌ | 与 Kysona 部分同协议，可复用 | JS |
| DAREU EM901X / A84 / A980 | `dareu.cpp` · HW | ❌ | 与 Compx 17B 不同 | JS |
| EWEADN S7/S9 全系 | `eweadn.cpp` · HW | 🟠 | 单个适配器即可覆盖 372E:103D/1027 | JS |
| AULA 键盘/鼠标（F75/F87/F99、SC580、X9 Ultra、HERO 68 Air） | `aula.cpp`、`aula_mouse.cpp` | 🟡 键盘部分 | 多套 report/命令 | JS |
| ASUS ROG 键盘/鼠标/Pelta 耳机 | `rog.cpp` · HW | 🟠 | 需要更多抓包和 `needs-capture` 补充 | JS |
| ZOWIE EC-CW/DW/U2 | `zowie.cpp` · HW | ❌ | 社区协议，HID 查询 | JS |
| VAXEE 4K/8K/NP-01S | `vaxee.cpp` · HW/docs | ❌ | 只读 feature report | JS |
| Finalmouse UltralightX/Starlight X | `finalmouse.cpp` · HW | ❌ | 需要 wake + GET | JS |
| WLmouse Beast/YING | `wlmouse.cpp` · HW | ❌ | 多接收器/线缆 | JS |
| LAMZU Aurora 系列 | `lamzu.cpp` · HW | ❌ | feature report | JS |
| Endgame Gear OP1w/XM2w | `endgame.cpp`、`endgame_we.cpp` · HW | ❌ | 4K 接收器/原接收器 | JS |
| Scyrox V12M | `scyrox.cpp` · HW | ❌ | 只有电量，无充电位 | JS |
| Ninjutso Sora/Ten | `ninjutso.cpp` · HW | ❌ | 两种 feature 命令 | JS |
| Sprime PM1 | `sprime.cpp` · HW | ❌ | feature report 0x05 | JS |
| RAWM/SADES/Attack Shark/Rongyuan/Xenta | `rawm.cpp`、`rongyuan.cpp`、`xenta_protocol.cpp` | ❌ | 型号极多，建议先做单个热门型号 | JS/Rust |
| Royal Kludge MG6 Pro | `royal_kludge.cpp` · HW | ❌ | QiWang 64B | JS |
| Machenike L7 | `machenike.cpp` · HW | ❌ | 248A:FF4C/FF4E | JS |
| MSI VERSA/GM31/GM41 | `msi.cpp` · HW | ❌ | 两套 vendor 查询 | JS |
| CHERRY MX 3.0S / XTRFY | `cherry.cpp` · HW | ❌ | XTRFY 复用 Compx | JS |
| Arbiter Akitsu | `arbiter.cpp` · HW | ❌ | feature 0x83 | JS |
| NuPhy WH80 | `nuphy.cpp` · HW/docs | ❌ | USB 查询 + 蓝牙 | JS |
| Audeze/ENDORFY/Turtle Beach/AKG/NZXT/Poly | 多个 RACE/GNP 驱动 · HW | ❌ | 耳机族，协议差异大 | JS |
| Jabra / JBL / Sony INZONE / Fractal | `jabra.cpp`、`jbl.cpp`、`sony_inzone.cpp`、`fractal.cpp` · HW | ❌ | 耳机专用查询 | JS |
| Alienware AW920H / MOONDROP / VGN | `alienware.cpp`、`moondrop.cpp`、`vgn.cpp` · HW | ❌ | 单一型号协议 | JS |
| Xbox / DS4 / Switch Pro / 8BitDo / GameSir / Flydigi / BEITONG | `xinput.cpp`、`playstation.cpp`、`switch_pro.cpp`、`eightbitdo.cpp`、`gamesir*.cpp`、`flydigi.cpp`、`beitong.cpp` | 🟡 仅 XInput/DS5 | BatteryHub 能拿真实百分比；当前 XInput 只有四档 | JS/Rust |
| Galaxy Buds / Nothing / AirPods | `galaxy_buds.cpp`、`nothing_ear.cpp`、`airpods.cpp` · HW | ❌ | RFCOMM / BLE 广播，不是 HID | Rust |
| Phone Link 手机电量 | `phonelink.cpp` · HW | 🟡 Rust 已实现，未真机验证 | 读 Phone Link 的 `StartMenuCompanion.json`；本机没有该文件 | Rust |
| 通用 HID Battery Usage | `generic.cpp` · 通用兜底 | 🟡 Rust 已实现，未真机验证 | `0x06:0x20` / `0x85:0x65`；覆盖大量标准设备 | Rust |
| Fast Pair / 蓝牙广播 | `ble_adverts.cpp`、`fastpair.cpp` | 🟡 Rust 已实现，未真机验证 | 已解析左/右/盒与充电位；设置页设备行显示组件标签，底栏保留最低电量 | Rust |
| HeadsetControl 耳机 | `headsetcontrol.cpp` + 外部 helper | ❌ | 需要随包携带/调用 helper | helper |

---

## 四、移植成本分类

### A. 只改 JS 适配器（推荐先做）

适用于 HID Feature/Output/Input 读写已够的协议：

- MCHOSE 现代鼠标/键盘
- ATK/VXE NK、Zero、8K Nano
- Keychron 鼠标
- Logitech G435 / ASTRO
- Razer 耳机
- SteelSeries / Corsair / HyperX / Glorious
- DAREU、EWEADN、AULA、ROG、ZOWIE、VAXEE、Finalmouse、WLmouse、LAMZU、Endgame、Scyrox、Ninjutso、Sprime、RK、Machenike、MSI、CHERRY、Arbiter、NuPhy

### B. 需要扩展 Rust daemon

- 通用 HID Battery Usage（已实现，未真机验证）
- ATK N9 串口（COM）
- Galaxy Buds / Nothing RFCOMM
- Fast Pair / BLE 广播拆分
- Phone Link（读系统卡片）
- 更完整的 Xbox/DS4/Switch 真实百分比（Windows.Gaming.Input）

### C. 外部 helper

- HeadsetControl（先确认随包分发和 GPL 合规）

---

## 五、优先级建议

### P0（高覆盖、低风险）

1. **通用 HID Battery Usage 兜底**：Rust 已实现，待有标准 HID 电池设备的用户验证。
2. **MCHOSE 现代系列**：5 个适配器已迁到市场（experimental），下一步补 A5 和 GLW 键盘并收集真机报告。
3. **ATK/VXE NK/Zero**：与现有 373B 家族相邻，HID 实现直接。
4. **Keychron 鼠标**：有测试，先做鼠标、不做需要固件补丁的键盘。

### P1

5. Logitech G435 / ASTRO、Razer 耳机。
6. SteelSeries / Corsair / HyperX / Glorious。
7. DAREU / EWEADN / AULA 全系补齐。
8. Fast Pair / BLE 广播（需要 Rust）。

### P2

9. 串口、RFCOMM、Phone Link、HeadsetControl。
10. 大量小众品牌/单一型号。

---

## 六、市场清单

当前市场索引 **8 条**：

| 状态 | 适配器 | 说明 |
|---|---|---|
| verified | `mchose-g87` / `atk-a9-plus` / `darkrim-shadow` | 与 factory stable 同 id，安装会被拒绝，显示“真机验证” |
| experimental | `mchose-5253` / `mchose-3837-legacy` / `mchose-modern` / `mchose-g3` / `mchose-k87` | 可安装，未真机验证 |

**只在 factory、没有进市场**：

- `compx-17b`
- `crociris-x7`
- `sony-dualsense`
- `logitech-hidpp`
- `mchose-20b`
- `mchose-v9`
- `rapoo-vt3s`
- `xiberia-t7`

这些适配器随插件包加载，用户不需要市场安装，所以没有复制到市场索引。市场不是 factory 的全量镜像。

**只有协议目录、还没有可安装适配器**：

- `razer-91`
- `dareu-a950`（实际由 Compx 适配器覆盖部分 PID）
- `eweadn-s9`
- `mchose-a7-ultra`
- `eweadn-a5pro`
- `atk-n9-headset`
- `mchose-k7-a5`
- `asus-64`

这些需要先写成 JS 适配器，才能进市场。

## 七、许可提醒

BatteryHub 是 **GPLv3**（见 `LICENSE`）。如果本插件不是 GPLv3 兼容分发：

- 不要直接复制 `src/drivers/*.cpp` 或测试代码；
- 可以阅读协议事实、自己重写 JS 适配器；
- 或者把插件整体调整为 GPLv3 兼容，并保留来源/版权声明。

设备 VID/PID、帧格式这类事实通常可以作为参考，但实现代码的表达仍受版权保护。移植前先确定许可证策略，避免后续分发问题。
