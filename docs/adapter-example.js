// 用户适配器示例（v1.1）。
//
// 放在 `%LOCALAPPDATA%\dsh-peripheral-battery\adapters\` 下，文件名随意（*.js / *.mjs）。
// 改完在对话里调用 battery_adapters({ action: "reload" }) 即可生效，不用重启 DSH。
//
// 沙箱里只有：defineAdapter、console、setTimeout / clearTimeout。
// 没有 require、process、fs、net —— 但这是防误用，不是防恶意代码：
// 适配器和插件一样，都是你自己安装、需要信任的代码。

defineAdapter({
  id: 'my-mouse',          // 稳定 key，用于设置/显示
  name: 'My Mouse',        // 显示名
  kind: 'mouse',           // keyboard / mouse / headset / controller / stylus
  transport: '2.4G',       // 显示在设备行上的连接方式
  match: {
    vid: '373B',           // 十六进制字符串或数字都可以
    pid: '1115',
    usagePage: 'FF02',     // 可选：同一 dongle 暴露多个集合时用来挑通道
  },
  async read(io) {
    // io.device 是匹配到的 HID 集合描述（vid/pid/usagePage/inputLen/outputLen/featureLen/product）。
    // io.exchange 每次调用都会重新打开设备、发一帧、把时限内的应答全部读回来。
    //
    // 输入上报型设备（雷柏、DualSense 等）用被动监听：
    //   const result = await io.listen({ seconds: 3 })
    //   result.reports 里是这段时间内设备主动上报的报文。
    //
    // mode:
    //   write   = interrupt OUT（WriteFile）
    //   setout  = HID SET_REPORT（控制管道）
    //   setfeat = HID SET_FEATURE
    //   getfeat = HID GET_FEATURE（此时 hex 是请求缓冲区，reports 里是回读的报文）
    const reply = await io.exchange({
      mode: 'write',
      hex: '08 7D 72 02 00 01 07 01',
      wait: 800,               // 等应答的毫秒数
      reads: 4,                // 最多收几帧
      // inLen / outLen / usagePage / usage 可选，默认用 io.device 的值
    })

    for (const report of reply.reports) {
      const bytes = report.split(' ').map((token) => parseInt(token, 16))
      // 下面的字节位置只是示例，真实协议必须按 probe listen / exchange 的抓包改。
      if (bytes.length >= 7) return { percent: bytes[6], charging: null }
    }
    throw new Error('设备无应答')
  },
})
