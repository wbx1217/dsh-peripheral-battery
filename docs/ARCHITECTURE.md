# 架构：Rust 能力 / JS 协议 / 市场长尾

这三层是边界，不是实现细节。新增设备时先判断它属于哪一层，避免把协议塞进 Rust，也避免把系统能力塞进适配器。

## 分层

| 层 | 负责 | 不负责 |
|---|---|---|
| **Rust daemon** | HID 枚举、打开、读写、Feature/Input/Output、BLE、XInput、串口/RFCOMM 等系统能力 | 厂商电量帧解析、设备型号知识、UI |
| **Factory JS** | 随插件发布的厂商协议、设备族匹配、解析电量/充电 | 枚举 HID、直接访问系统 API、长期后台服务 |
| **User JS** | agent 现场适配、用户私有设备、社区长尾 | 冒充出厂适配器、覆盖出厂文件 |
| **Market** | 分发、策展、SHA-256 校验、预览/安装/回滚 | 静默执行第三方代码 |

一句话：**Rust 做“能力”，JS 做“协议”，市场做“长尾”。**

## 为什么不是全 Rust

- BatteryHub 这类项目有 100+ 驱动文件，逐个移植是真实工作量；换语言不会自动获得覆盖。
- 厂商协议型号多、固件差异大，JS 可以热加载、快速试错、社区提交。
- 没有任何 Rust 工具链的用户，仍然需要 agent 生成适配器；agent 写 JS 比让用户装 cargo 现实得多。
- 协议解析耗时远小于 HID 查询本身，JS 不是性能瓶颈。

全 Rust 只适合“稳定、通用、系统级”的部分。

## 决策树

```
新设备要接进来
├─ 是否只是标准 HID Battery Usage（0x06:0x20 / 0x85:0x65）？
│  └─ 是 → Rust 通用兜底（不要为每个 VID/PID 写适配器）
├─ 是否需要新的系统能力？
│  ├─ 串口 / RFCOMM / 蓝牙广播 / Phone Link / Windows.Gaming.Input
│  └─ 是 → Rust 新原语 + 测试
├─ 是否是厂商私有 HID 帧（查询或被动上报）？
│  ├─ 是 → JS 适配器（factory 或 user）
│  └─ 发现未适配设备时 → 先查 market 匹配，给用户「查看/安装」
└─ 是否已有公开协议/抓包？
   ├─ 是 → 先写 JS，补测试，再考虑进 factory
   └─ 否 → agent probe/listen/exchange 抓包，再写 JS
```

## 能力边界

### Rust daemon 暴露给 JS 的 IO

适配器不直接接触 Windows API，只拿到 `io`：

| API | 用途 |
|---|---|
| `io.device` | 当前匹配到的 HID 集合快照：`vid/pid/usagePage/usage/inputLen/outputLen/featureLen/product` |
| `io.exchange({ mode, hex, wait, reads, ... })` | 发一帧并读应答；`mode`: `write` / `setout` / `setfeat` / `getfeat` |
| `io.listen({ seconds, vid, pid, usagePage })` | 只读监听设备主动上报 |
| `io.open()` / `io.withSession()` | 需要多步读写时保持会话 |
| `io.sleep(ms)` | 等待设备/接收器 |
| `io.listDevices()` | 枚举当前 HID 集合（调试用） |

会话对象提供 `read/write/getFeature/setFeature/flush/close`。

### 什么时候必须改 Rust

- 新传输：串口、RFCOMM、蓝牙广播、Phone Link；
- 新系统 API：`Windows.Gaming.Input`、更完整的 BLE GATT；
- 通用兜底：标准 HID Battery Usage、通用蓝牙电量；
- 多设备接收器槽位扫描等需要跨集合的能力。

**不要**把“某个厂商的 20 字节帧”写进 Rust。那属于 JS。

### 什么时候写 JS

- 厂商私有 HID 协议；
- 同一接收器下多 PID/型号的匹配；
- 设备休眠、回显、校验、充电位等协议细节；
- agent 现场生成、用户自定义、市场分发。

## 新增设备的标准流程

1. **认设备**
   - 设置页「新设备 → 扫描新设备」，或 `battery_detect`；
   - `battery_probe` 看 usagePage / report 长度。
2. **查协议目录**
   - `battery_protocols` 匹配 `protocols/catalog.js`；
   - 命中就按帧格式写 JS；没命中就抓包。
3. **抓包**
   - 查询型：`battery_exchange`；
   - 上报型：`battery_listen`。
4. **写适配器**
   - 从 [`templates/adapter-template.js`](../templates/adapter-template.js) 复制；
   - 详细 API 与提交规则见 [`docs/ADAPTERS.md`](ADAPTERS.md)。
5. **校验**
   - `npm run check:adapters`；
   - `battery_adapters({ action: "reload" })`；
   - `battery_status({ refresh: true })` 对比真实电量；
   - 测试休眠、拔出、充电。
6. **决定归属**
   - 通用/稳定/可维护 → factory `adapters/`；
   - 个人设备/实验性 → user `%LOCALAPPDATA%\dsh-peripheral-battery\adapters`；
   - 社区长尾 → market 索引。

## Factory 与 User 的边界

- factory 随插件更新，不能有用户私有路径/密钥；
- user 永不覆盖，id 冲突时保留 factory；
- market 安装写到 user，必须有 SHA-256 和源码预览；
- factory 文件名不能被 user 占用。

## 证据层级与晋级

Factory 不是“品牌列表”，而是证据等级：

| 层级 | 含义 | 默认行为 |
|---|---|---|
| **stable** | 维护者/可信测试者在真实硬件上验证 | 随 factory 加载 |
| **beta** | 上游真机验证或有测试向量，但本插件未验证 | 随 factory 加载，可在设置关闭 |
| **market** | 未验证、单一型号、社区提交 | 按设备匹配，用户确认安装 |
| **user** | agent/用户本地写入 | 热加载，不进市场 |

晋级流程：

```
market experimental
  → 补齐真实硬件证据 / 可复现测试
  → beta（factory，明确标注未验证）
  → stable（factory，本机或可信测试者验证）
```

`verified` 的验收至少包括：

- 电量与厂商软件一致；
- 充电/放电状态正确；
- 休眠、关机、拔出行为正确；
- 记录型号、固件、接收器 PID；
- 测试向量可复现。

**不要把“上游 HW”直接写成我们的 `verified`**；上游测试只能作为 beta 证据。

用户侧验证闭环：

```
安装 market experimental
  → 设置页「查看 → 复制验证报告」
  → 市场仓库 verification issue
  → 维护者审核
  → community（市场）/ verified（可进 factory stable）
```

报告包含适配器 id/hash、插件/daemon 版本、设备读数、验证清单；CI 和测试向量不能替代真机报告。

## 数据源诊断

每个数据源都要回答“是否执行、处理了多少、为什么为空”：

- XInput；
- 通用 HID Battery（枚举集合数 / 匹配数）；
- BLE（GATT / Windows / Fast Pair 设备数、Fast Pair 广告数、watcher 错误）；
- Phone Link（卡片文件是否存在、年龄、解析错误）。

设置页服务卡显示摘要；「复制诊断」带完整 `sources`。

## Host 深模块

Host 不把所有逻辑堆在 `index.js`：

- `source-ledger.js`：唯一的数据源账本，负责每个源的默认值、合并与诊断文案；
- `device-view.js`：把原始读数、注册表、上次读数合成快照与设备列表；纯函数，可在 Node 下测；
- `adapter-catalog.js`：factory builtIn、市场条目、安装记录与 VID/PID 匹配的唯一投影；
- `daemon-client.js`：sidecar spawn、RPC、超时、事件与重启的 seam。

adapter 不直接拿宿主 `io` 对象：Host 用 JSON 桥传递帧/应答，adapter 侧的 `io` 由沙箱工厂创建。`node:vm` 仍不是安全边界，但宿主函数不会作为可直接调用的对象进入 adapter。

## 测试与证据

- 协议事实、抓包、测试向量优先放进 `protocols/catalog.js` 或适配器注释；
- 新增 factory 适配器至少要有：真实设备读数、休眠/拔出行为、充电位（若协议支持）；
- 未在本机验证的适配器必须标明 `experimental`，不要写成 `verified`；
- 出处和许可证写清楚（Voltide、HaloBattery、厂商 web driver 等）。

## BatteryHub 100+ 驱动的落位

不要把 113 个 C++ 驱动 1:1 搬成 113 个 Rust 模块或 113 个 JS 文件。BatteryHub 的很多文件共享同一协议族，只是 VID/PID/型号不同。

### 先归并，再分层

| 类型 | BatteryHub 例子 | 放哪 | 归并方式 |
|---|---|---|---|
| 通用 HID Battery Usage | `generic.cpp` | **Rust 能力**（已实现，未真机验证） | 一个通用兜底，不按 VID/PID 拆 |
| 蓝牙/Windows 已知电量 | `generic.cpp` | **Rust 能力** | 一个 BLE 通道 |
| Fast Pair / BLE 广播 | `ble_adverts.cpp`、`fastpair.cpp` | **Rust 能力**（已实现，未真机验证） | 一个 BLE 广播解析器 |
| RFCOMM 耳机 | `galaxy_buds.cpp`、`nothing_ear.cpp` | **Rust 传输 + JS 解析**（或先 Rust 整体） | 一个 RFCOMM 能力 |
| 串口耳机 | `atk_serial.cpp` | **Rust 传输 + JS 解析** | 一个 COM 能力 |
| Phone Link | `phonelink.cpp` | **Rust/系统集成**（已实现，未真机验证） | 一个系统能力 |
| Xbox/DS4 真实百分比 | `xinput.cpp`、`playstation.cpp` | **Rust 能力**（Windows.Gaming.Input） | 按 API，不按型号 |
| HeadsetControl | `headsetcontrol.cpp` | **外部 helper** | 一个 helper 集成 |
| 厂商 HID 协议族 | `kysona.cpp`、`logitech.cpp`、`razer.cpp`、`mchose*.cpp`、`keychron.cpp`、`steelseries.cpp`、`corsair.cpp`、`hyperx.cpp`、`dareu.cpp`、`eweadn.cpp` … | **Factory JS** | 一个协议族一个 JS 文件，`match.vid/pid` 用数组 |
| 小众/实验性/固件特定 | 各种 `misc_mice.cpp`、`rawm.cpp`、`xenta_protocol.cpp`、Needs-capture | **User JS / Market** | 一个型号或一个社区适配器 |

### 推荐的 factory 文件结构

按“协议族”而不是“品牌型号”建文件，`match` 用数组覆盖多个 PID：

```text
adapters/
  logitech-hidpp.js
  logitech-g435.js
  logitech-astro.js
  razer-feature.js
  razer-headset.js
  steelseries.js
  corsair.js
  hyperx.js
  glorious-kysona.js
  atk-kysona.js
  atk-bitmouse.js
  mchose-modern.js
  mchose-keyboard.js
  mchose-headset.js
  keychron-mouse.js
  keychron-keyboard.js
  dareu.js
  eweadn.js
  aula.js
  rog.js
  ...
```

这样 100+ BatteryHub 驱动通常会收敛成 **30–50 个协议族**，而不是 100+ 个文件。同一协议的不同型号只改 `match` 和少量解析分支。

> 当前适配器加载器只扫描 `adapters/` 的**平铺文件**，不递归子目录。如果要按 `adapters/logitech/…` 分组，需要先改加载器支持递归；在改之前用 `vendor-protocol.js` 的平铺命名即可。

### Factory 还是 Market

判据不是“品牌大小”，而是：

**放 factory：**

- 协议稳定、可维护；
- 本机或可靠来源验证过；
- 用户量大；
- 不依赖用户私有配置/固件；
- 失败语义清楚（休眠/拔出/错误）。

**放 user / market：**

- 只有一个用户/一个型号；
- 还在抓包阶段；
- 固件差异大、经常变；
- 需要用户自己承担信任风险；
- 来源许可证不适合直接内置。

“100 个都放 market”也不对：高频设备应该在 factory 开箱可用，market 只做长尾。

### Rust 侧不要按设备建模块

Rust 只应该有“能力模块”，例如：

```text
rust/src/hid/        # 枚举、会话、读写
rust/src/ble.rs      # BLE GATT / Windows 已知
rust/src/xinput.rs   # XInput
# 以后：
rust/src/serial.rs   # COM
rust/src/rfcomm.rs   # RFCOMM
rust/src/ble_adv.rs  # Fast Pair / 广播
```

厂商协议不进入 `rust/src`。否则每加一个型号都要发 Rust 版本，回到“全 Rust”的问题。

### 一个可执行的分批

1. **Rust 通用能力**：generic HID battery、BLE/Fast Pair、XInput 真百分比；
2. **JS 高频族**：Logitech、Razer、MCHOSE、ATK/Kysona、Keychron、DAREU、EWEADN；
3. **JS 中频族**：SteelSeries、Corsair、HyperX、Glorious、ROG、ZOWIE、VAXEE；
4. **User/Market**：实验性型号、固件特定、长尾社区；
5. **Rust 新传输**：串口、RFCOMM、Phone Link、HeadsetControl 按需补。

## 相关文档

- [新增 JS 适配器](ADAPTERS.md)
- [BatteryHub 覆盖矩阵](COVERAGE.md)
- [适配器市场](MARKET.md)
- [实现细节](IMPLEMENTATION.md)
