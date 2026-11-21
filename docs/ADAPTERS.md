# 新增 JS 适配器

面向“厂商私有 HID 协议”的贡献指南。系统级能力（串口、RFCOMM、蓝牙广播、通用 HID Battery）应改 Rust，见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 快速开始

```powershell
# 在插件目录生成一个 factory 适配器
node scripts/new-adapter.mjs my-device "My Device"

# 或生成到用户适配器目录（不需要改插件包）
node scripts/new-adapter.mjs my-device "My Device" --user
```

然后编辑生成的文件，至少修改：

- `match.vid` / `match.pid`；
- `usagePage` / `usage`（如果协议只在特定集合上）；
- `read(io)` 里的查询帧、应答解析。

## 适配器结构

```js
defineAdapter({
  id: 'my-device',        // 唯一；安装/去重用，不要随便改
  tier: 'beta',           // factory 用：stable（真机验证）或 beta（未验证）
  name: 'My Device',      // 展示名；可在 read() 里返回动态 name
  kind: 'mouse',          // mouse/keyboard/headset/controller/other
  transport: '2.4G',
  showWhenMissing: false, // 仅当设备没插入也要显示占位时设 true
  match: {
    vid: '1234',          // 必填；可以是数组
    pid: '5678',          // 可选；省略表示该 VID 整个协议族
    usagePage: 'FF02',    // 可选；建议限制，避免匹配错集合
    // usage: '0002',
    // inLen: 20, outLen: 20, featureLen: 0,
  },
  async read(io) {
    // 1. 发查询 / 监听上报
    // 2. 跳过接收器回显和无关帧
    // 3. 校验长度、校验和、电量范围
    // 4. 返回 { percent, charging?, name? }
    throw new Error('设备无应答（可能休眠）')
  },
})
```

## `io` API

| API | 说明 |
|---|---|
| `io.device` | 当前匹配集合的只读快照：`vid/pid/usagePage/usage/inputLen/outputLen/featureLen/product` |
| `io.exchange({ mode, hex, wait, reads, ... })` | 发一帧并读应答，返回 `{ reports: string[] }`；`reports` 是 `"13 4A ..."` 形式的十六进制字符串 |
| `io.listen({ seconds })` | 只读监听主动上报，返回 `{ reports: string[] }`；不写设备 |
| `io.open()` | 打开会话，返回 `read/write/getFeature/setFeature/flush/close` |
| `io.withSession(options, fn)` | 自动关闭的会话；适合多步协议 |
| `io.sleep(ms)` | 等待接收器/设备 |
| `io.listDevices()` | 调试用：列出当前 HID 集合 |

`exchange` 的 `mode`：

- `write`：interrupt OUT（WriteFile）
- `setout`：HID SET_REPORT（Output）
- `setfeat`：SET_REPORT（Feature）
- `getfeat`：GET_REPORT（Feature）

`wait` 是等待应答的毫秒数，`reads` 是最多读几帧；默认 800ms / 4 帧。

`reports` 示例：

```js
const result = await io.exchange({
  mode: 'setout',
  hex: '13 4A 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 5E',
  wait: 900,
  reads: 4,
  inLen: 20,
})
```

## 查询型模板

```js
async read(io) {
  const result = await io.exchange({
    mode: 'setout',
    hex: '08 04 00 00 00 00 00 00 00 00 00 00 00 00 00 00 49',
    wait: 900,
    reads: 4,
    inLen: 17,
  })

  for (const report of result.reports) {
    const bytes = report.trim().split(/\s+/).map((v) => parseInt(v, 16))
    if (bytes.length < 8) continue
    // 跳过接收器回显：查询帧的 [4] 是 0
    if (bytes[0] === 0x08 && bytes[1] === 0x04 && bytes[4] === 0x00) continue
    if (bytes[0] !== 0x08 || bytes[1] !== 0x04) continue
    const percent = bytes[6]
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) continue
    return { percent, charging: bytes[7] === 1 }
  }

  throw new Error('设备无应答（可能休眠）')
}
```

## 上报型模板

```js
async read(io) {
  const result = await io.listen({ seconds: 5 })
  for (const report of result.reports) {
    const bytes = report.trim().split(/\s+/).map((v) => parseInt(v, 16))
    if (bytes.length < 19 || bytes[0] !== 0x07) continue
    const percent = bytes[8]
    if (percent < 0 || percent > 100) continue
    return { percent, charging: bytes[7] >= 2 }
  }
  throw new Error('设备无应答（可能休眠）')
}
```

## 状态语义

- factory 适配器必须标 `tier`：`stable` 表示本机真机验证，`beta` 表示未真机验证；
- 设置页「实验性适配器」关闭后只加载 stable；
- 返回 `{ percent: 0..100 }` 才是成功；
- 设备休眠/没开机：**抛错**，不要返回 0%；
- 无法判断充电：`charging: null` 或省略；
- 读不到但设备存在：让宿主落到 `asleep` / `error`，不要伪造 `unplugged`；
- `showWhenMissing` 只给“用户自己的设备”用，避免宽匹配适配器给所有人显示幽灵设备。

## 匹配规则

- `vid` 必填；`pid` 可省略，表示整个厂商协议族；
- **一个协议族一个文件**：同一协议的不同型号用 `vid`/`pid` 数组覆盖，不要为每个 PID 复制一份适配器；
- 一个适配器只能返回一台设备的读数；同一接收器多设备要用多适配器或 Rust 槽位能力；
- `usagePage` / `usage` / 长度能限制就限制，避免匹配到同 VID 的其他集合；
- 宽匹配适配器（省略 `pid`）必须有可靠的 `read()` 和失败语义。

## 校验与调试

```powershell
# 语法 + defineAdapter + match 校验（只读，不执行 read）
npm run check:adapters

# 检查用户目录（可选）
npm run check:adapters -- --user

# 运行适配器的离线协议测试（市场仓库内）
node --test tests/*.test.mjs
```

运行中：

```js
battery_adapters({ action: 'reload' })
battery_status({ refresh: true })
```

建议至少验证：

- 真实电量与厂商软件一致；
- 设备休眠/关机时不误报 0%；
- 充电/放电位；
- 接收器回显是否被跳过；
- 重复刷新不会让读数乱跳。

## Factory 还是 User

| 放哪里 | 适用 | 安装方式 |
|---|---|---|
| `adapters/` | 稳定、通用、可维护、随插件发布 | 插件更新 |
| `%LOCALAPPDATA%\dsh-peripheral-battery\adapters` | 个人设备/实验性 | agent `battery_save_adapter` 或手动 |
| market | 社区长尾 | 设置页搜索/预览/安装 |

Factory 适配器不能覆盖用户文件；用户 id 冲突时保留 factory。未真机验证的 factory 适配器必须标注 experimental，不要冒充 verified。

## 安全与许可

- 适配器运行在 `node:vm` 软隔离中，只有 `defineAdapter`、`console`、定时器；没有 `require`/`fs`/`net`；
- **这不是安全边界**：适配器拥有 HID 读写能力，安装前必须审阅源码；
- 从其他项目移植时保留出处和许可证；BatteryHub 是 GPLv3，不能直接复制实现，见 [COVERAGE.md](COVERAGE.md#六许可提醒)。
