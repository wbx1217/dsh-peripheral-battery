# 无线外设电量：设计与使用说明

> **v0.2 重构提示**：协议实现已全部迁移到 JS 适配器，Rust 侧只剩 HID 会话、Rust WinRT BLE、XInput 与 JSON-lines RPC。本文档前半部分保留重构前的设计记录；当前架构、设备管理与性能数据以 [README.md](../README.md) 为准。

## 为什么做这个

Windows 设置里只能看到「蓝牙栈已知电量」的设备；2.4G 私有 dongle（罗技 Bolt/Unifying、各家键盘鼠标、杰理方案耳机……）根本不走那条路，想看电量就得装几百 MB 的厂商驱动。这个插件只做一件事：**用 HID 私有协议直接问设备**，把结果接进 DSH——对话里能问、底栏能看、快没电时弹系统通知。

上游的 `PeripheralBattery` 已经用 Rust 把两台设备的协议真机逆完了（见其 `docs/PROTOCOLS.md`）。本插件把那套库裁剪成无 UI 的侧车，用 JSON 暴露给 DSH。

## 架构（v0.2）

```
DSH Host 插件 (index.js) ── daemon-client.js ── JSON-lines RPC ──► peripheral-battery-daemon.exe
   │                                                              ├─ HID 枚举 / 会话（适配器 I/O）
   │                                                              ├─ Rust WinRT BLE（GATT + Windows 已知属性）
   │                                                              └─ XInput
   ├─ 设备注册表（devices.json）
   ├─ 缓存快照 / 渐进发布 / 阈值检测
   └─ tools + HTTP 路由（status / settings / devices / refresh）
Client 半：shell.bottom 摘要 + 内联设置 + 设置页设备管理（改名/显隐/拖拽排序）
```

- **daemon**：常驻、JSON-lines RPC；空闲默认 15 分钟退出，宿主按需拉起；HID 会话可复用，适配器不再每次 spawn 进程。
- **Host**：daemon 的 `WM_DEVICECHANGE` 事件触发即时刷新；底栏通过长轮询接收快照变化，没有固定间隔轮询；查询默认读缓存，`refresh: true` / 手动刷新才重新查询；设备元数据持久化，读数只留内存。
- **BLE**：Rust 内完成，先 GATT `0x180F/0x2A19`，再 Windows 已知电量属性，并用 `BluetoothDevice.ConnectionStatus` 过滤关机残留节点；一次扫描约 1 秒。
- **CLI**：只保留 HID 枚举/监听/收发原语，供 `battery_probe` 与适配器调试；旧 `status` 子命令已移除。

## 数据模型

`battery_status` 返回：

```json
{
  "ok": true,
  "schema": "dsh-peripheral-battery/status@1",
  "sidecarVersion": "0.1.0",
  "generatedAtMs": 1794980295507,
  "version": 1,
  "onlineCount": 0,
  "devices": [
    {
      "key": "mchose-g87",
      "name": "MCHOSE G87",
      "kind": "keyboard",
      "transport": "2.4G HID",
      "status": "asleep",
      "percent": null,
      "charging": null,
      "updatedAt": null
    }
  ]
}
```

状态：`online` / `asleep` / `unplugged` / `error`。`charging` 为 `null` 表示协议里没有充电位（DARKRIM 耳机就是这样），不猜。`unplugged` 是注册表占位（设备当前不在），可带上次读数；隐藏设备不出现在 `devices` 里，但仍在设备注册表中。

## 适配器：出厂与用户

- **出厂适配器**：插件包内 `adapters/`，随插件更新，直接从包内加载，不会复制到用户目录；
- **用户适配器**：`%LOCALAPPDATA%\dsh-peripheral-battery\adapters\` 里的 `.js` 文件，插件更新永远不会覆盖或删除；
- 旧版本复制到用户目录的出厂副本会在升级时移到 `adapters-legacy-backup/`，不再参与加载；
- 出厂优先：用户适配器 id 与出厂冲突时保留出厂并报错；用户文件名也不能与出厂相同。

适配器在 `node:vm` 上下文里执行：

```js
defineAdapter({
  id: 'atk-a9-plus',
  name: 'ATK A9 Plus',
  kind: 'mouse',
  transport: '2.4G · 星闪',
  match: { vid: '373B', pid: '1115', usagePage: 'FF02' },
  async read(io) {
    const { reports } = await io.exchange({
      mode: 'write',   // write=interrupt OUT / setout=SET_REPORT / setfeat / getfeat
      hex: '08 04 00 00 00 00 00 00 00 00 00 00 00 00 00 00 49',
      wait: 900, reads: 4, inLen: 17,
    })
    for (const report of reports) {
      const bytes = report.split(' ').map((token) => parseInt(token, 16))
      if (bytes[0] === 0x08 && bytes[1] === 0x04 && bytes[6] <= 100) {
        return { percent: bytes[6], charging: bytes[7] === 1 }
      }
    }
    throw new Error('设备无应答（鼠标可能休眠）')
  },
})
```

沙箱只提供 `defineAdapter`、`console`、`setTimeout` / `clearTimeout`；`io` 只提供 `device`、`listDevices()`、`exchange()`、`sleep()`。没有 `require`/`fs`/`net`/`process`。**这是软隔离，不是安全边界**：适配器和插件一样，是用户自己安装、需要信任的代码。

出厂适配器放在插件包的 `adapters/` 目录里，直接从包内加载，不复制到用户目录；用户目录只放用户自己的适配器。ATK A9 Plus 装上插件就能读。

### 第一个试点：ATK A9 Plus（373B:1115）

| 项 | 值 |
|---|---|
| 集合 | Usage Page `0xFF02`、Usage `0x02`、Report ID `0x08`、17 字节（含 ID） |
| 校验 | 全部 17 字节之和 ≡ `0x55`（mod 256） |
| 查询 | `08 04 00 ×14 49` |
| 应答 | `08 04 .. .. .. len [6]=电量% [7]=充电/有线 [8..9]=电芯 mV（大端）` |
| 实测 | `08 04 00 00 00 02 64 01 10 46 ... 8C` → 100%、充电中、4166 mV |
| 休眠 | 鼠标休眠时接收器不应答，移动一下鼠标再查 |

协议来源：Linux 主线 `hid-kysona` 驱动、LKML 上的报告描述符、`atk-tool` / `libatk-rs` / `mouse_tray` 多个实现互证。不要用 `373B:1216` 那套 0xFF05/64 字节协议——那是上一代硬件。

### 逆向一台新设备的流程

用户不需要知道 VID/PID。让他插上接收器、打开设备，剩下由 agent 完成：

1. `battery_detect({ mode: "watch", seconds: 20 })`：对比前后枚举，只报窗口期内新出现的厂商 HID 设备（带产品名）。设备已经插着时用 `mode: "list"`。
2. `battery_probe`：看目标设备暴露的集合（usage page、报文长度、是否有 feature）。
3. `probe listen --vid X --pid Y --usage-page Z --secs N`：被动抓包（部分设备只在移动时上报）。
4. `probe exchange --vid X --pid Y --hex "..." --mode write|setout|getfeat --wait 800`：试探请求帧。
5. 抓到应答后写适配器，调用 `battery_adapters({ action: "reload" })` 热加载。
6. 如果产品名为空，`watch` 模式的差分结果就是最可靠的识别依据。

### 协议目录与一句话适配

`protocols/catalog.js` 把已知协议做成数据：匹配条件（VID/PID/usage page/报文长度）、帧格式、解析规则、验证状态（verified / experimental / needs-capture）和来源。

- `battery_protocols`：拿当前 HID 集合去匹配目录，命中后直接给出帧格式和注意事项。
- `battery_save_adapter`：agent 生成 `defineAdapter(...)` 源码后写入用户适配器目录（语法检查 + 必须调用 defineAdapter），然后热加载。
- 目录只是知识，不是自动执行的代码：未验证的协议不会被静默启用，必须由 agent（或用户）落成适配器并在真机上验证。

因此“没有硬件验不了”的协议（如 Logitech HID++、Razer 91B）仍然有价值：协议知识随插件分发，用户自己的设备就是验证环境。

## 蓝牙（BLE）

蓝牙扫描在 Rust daemon 内完成（不再走 PowerShell），结果并入同一份快照：

1. **GATT Battery Service**：用 `windows` crate 的 WinRT 接口枚举 BLE 设备，读 `0x180F` 服务的 `0x2A19` 特征值。
2. **Windows 已知电量**：用 SetupAPI 读蓝牙 devnode 的电池属性 `{104EA319-…} 2`，覆盖经典蓝牙设备。
3. **连接状态过滤**：蓝牙 PnP 节点和电量属性在设备关机后仍会保留，因此先建立「蓝牙地址 → `BluetoothDevice.ConnectionStatus`」映射，非 `Connected` 直接跳过——关机设备会变成「已拔出」而不是继续显示旧电量。

一次扫描约 1 秒，结果缓存 10 分钟；`battery_ble({ action: "scan" })` 可随时重扫，手动刷新超过 30 秒会重新扫描。

已知限制：

- GATT 主动读取尚未在真实 BLE 外设上实测；经典蓝牙路径已用本机音箱验证（开机 60%，关机变「已拔出」）。
- 设备必须已配对、在附近；GATT 读取可能唤醒设备，也可能因休眠失败。
- 经典蓝牙设备通常没有标准 GATT 电量，只能依赖 Windows 是否上报。

## XInput 手柄

Xbox 兼容手柄（Series X|S、8BitDo 等）不暴露厂商 HID 集合，Windows 把它们绑到 Xbox 驱动上，唯一的公开通道是 XInput：

- 枚举槽位 0–3（`XInputGetState`）；
- `XInputGetBatteryInformation` 只返回四档：`empty / low / medium / full`，映射为 **5 / 20 / 50 / 100%**（取每档中间值，和 Voltide 一致）；
- 有线手柄（BatteryType = 1）显示 100% 充电中；
- 输出里带 `source: "xinput"` 与 `level` 字段，方便前端区分“四档”和“真实百分比”。

它不走侧车的 HID 路径，而是 `status` 命令里单独的一段；没有手柄时就是空数组，不影响其它设备。

## 与 Voltide 的差异和借鉴

参考项目 Voltide（C#，MIT）覆盖了约 30 个设备家族。我们对比后有意只取一部分：

| 能力 | Voltide | 本插件 | 取舍 |
|---|---|---|---|
| Provider 接口 | `Discover(catalog)` + `Read(device)` | 内置 `BatteryProvider::matches/read`；适配器 `match` + `read(io)` | 我们保留了热加载适配器，但还没有多设备 discover |
| 枚举 | 每次刷新枚举一次 catalog，所有 provider 共享 | 侧车每次调用枚举一次；适配器再走 `probe list` | 设备多时 Voltide 更省；我们可后续把 catalog 传给适配器 |
| 多设备 | 一个 receiver 可产出多个 DeviceInfo（Logitech 索引 1..4、XInput 槽位 0–3） | 一个适配器 = 一台设备；XInput 例外 | Logitech 需要多设备模型，暂未移植 |
| 读数模型 | Online/Percent/Level/Charging/Error/Detail/Raw | status 四态 + percent/charging | 我们缺 error/raw 文本，调试时信息更少 |
| 协议 | HID++ 2.0、Razer 91B、XInput、ROG、PS5 等 | 2.4G 三族 + BLE + XInput | 已借用 Compx 17B、MCHOSE 20B、XInput 映射 |

1118 版新增的 RAPOO VT3S、DualSense、XIBERIA T7、CROCIRIS X7、MCHOSE V9、DAREU A950 已作为实验性适配器加入；其中 RAPOO 与 DualSense 是输入上报型，通过 `io.listen()` 只读监听实现。

尚未移植但已确认可做的：

- **Logitech HID++ 2.0**：需要 receiver 槽位扫描（1..4）、feature 0x1000/0x1004 发现，以及“每帧必须匹配设备号 + feature 索引 + function/swId”的严格收包。它天然是一个“多设备 provider”，建议做成内置 Rust 实现而不是单设备适配器。
- **Razer 91 字节 Feature 通道**：需要 write-only 打开（鼠标集合拒绝读权限）+ `HidD_GetFeature` 轮询 + 字节 3..88 的 XOR 校验。侧车需要先支持 `--write-only` 与多次 feature 读取，才能用适配器实现。
- **ROG / PS5 / 雷柏 / 达尔优 / XIBERIA** 等 64B/自定义协议：都可以按同样方式做适配器，但每台都需要真机应答帧校验。



## 提醒策略

- 只在「设备在线、正在放电、percent ≤ 阈值」且**本轮刚跨过阈值**时提醒一次。
- 设备充电、或回到「阈值 + 5%」以上，重新武装；同一段放电过程不会反复轰炸。
- 提醒走 Windows Toast：`powershell.exe` 5.1 + WinRT，AUMID 借用 DSH 安装器注册的 `com.deepseek.dsh`，因此不需要写开始菜单快捷方式。
- 已知限制：通知归属显示为 DeepSeek Harness；点击不会激活 DSH（该快捷方式没有 ToastActivatorCLSID）。

## 设置

存在 `%LOCALAPPDATA%\dsh-peripheral-battery\settings.json`：

| 键 | 默认 | 范围 |
|---|---|---|
| `intervalMinutes` | 30 | 1–1440 |
| `thresholdPercent` | 20 | 1–99 |
| `notify` | true | boolean |

也可以在 `cordis.patch.yml` 的行 `config` 里给初始值（文件设置优先）。tool `battery_config` 与设置页「外设电量」改的是同一个文件，立即生效，不重启 DSH。

## 当前支持范围（诚实版）

- 仅 Windows；仅 2 台真机验证过的设备。
- 新设备 = 先 `battery_probe` 看 HID 集合，再用 `probe exchange`（JSON）试探报文。v1.1 会把这套流程做成「用户可写 JS 适配器」：适配器跑在 `node:vm` 里，只拿到列设备/读写/超时的受限 API，不能 `require` 任意模块。社区适配器本质上仍是代码，安装前需要用户自己信任——和安装插件同级。
- BLE 设备（蓝牙耳机、触控笔）走 GATT Battery Service 是另一条数据源，v2 再做。

## 安全与隐私

- 插件不含任何网络上传；数据只在本机进程间流动。
- 侧车以 DSH 进程权限运行，只打开 HID 设备做读写，不写设备状态（`probe exchange` 的 `write` / `setout` 只有显式调用才会写）。
- 第三方插件本身以 DSH 权限执行任意 Node 代码——这是 DSH 的插件信任模型，不是本插件引入的。
