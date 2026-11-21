// 已知 2.4G / 蓝牙电量协议目录。
//
// 这里只放"协议知识"，不放可执行逻辑：agent 用 battery_protocols 匹配设备，
// 再按目录里的帧格式/解析规则生成适配器，用 battery_save_adapter 热加载验证。
//
// status:
//   verified         本机真机验证过
//   experimental     有成熟开源实现/真机抓包，但未在对应型号上由本插件验证
//   needs-capture    只知道设备类/集合形状，需要用户配合抓包

export const PROTOCOLS = [
  {
    id: 'compx-17b',
    name: 'Compx / DAREU 17 字节（ATK / VXE / IMECOO / 达尔优）',
    status: 'verified',
    transport: '2.4G',
    match: {
      vid: ['373B', '3554', '260D'],
      pid: ['1115', '1278', '10C9', 'FB34', '1175'],
      usagePage: 'FF02',
      inLen: 17,
      outLen: 17,
    },
    frame: '08 04 00 ×14 49（16 字节载荷之和 ≡ 0x4D，等价全帧和 ≡ 0x55）',
    parse: 'reply[6]=电量%、[7]=充电(1)/放电(0)，达尔优 2=已充满、[8..9]=电芯 mV（大端）',
    notes:
      '写入方式因固件而异：IMECOO/达尔优支持 WriteFile，ATK/VXE 只认 SET_REPORT；两条都试。接收器会回显查询帧，必须跳过。',
    source: 'Voltide (MIT) / Linux hid-kysona',
  },
  {
    id: 'mchose-20b',
    name: 'MCHOSE 20 字节',
    status: 'verified',
    transport: '2.4G',
    match: {
      vid: ['41E4', '3554', '258A'],
      pid: ['2001', 'FA09', '01BB'],
      usagePage: 'FF02',
      inLen: 20,
      outLen: 20,
    },
    frame: '13 4A 01 00 00 ×14 5E（前 19 字节和 & 0xFF）',
    parse: 'reply[5]=电量%、[6] 高半字节=充电状态（1=充电）',
    notes: '接收器会先回显查询帧（frame[4]==0），必须跳过，否则读到 0%。',
    source: 'Voltide (MIT) / 本机 G87 验证',
  },
  {
    id: 'logitech-hidpp',
    name: 'Logitech HID++ 2.0',
    status: 'experimental',
    transport: '2.4G · Lightspeed/Unifying/Bolt',
    match: { vid: ['046D'], usagePage: 'FF00', outLen: 20 },
    frame:
      '20 字节长报文：11 [dev 1..4] [featureIndex] [(function<<4)|swId] ...；swId 用 0x0E（避开 G HUB 的 0x0D）',
    parse:
      '先 ping 槽位 1..4；feature 0x1000 function 0 → reply[4]=电量%、[5]&0x02=充电；0x1004 function 1 → reply[4]=电量%。0x1004 function 0 是电压，会让 G HUB 误判，不要请求。',
    notes:
      '收包必须同时匹配设备号、feature 索引和 function/swId 字节。一个接收器可挂多台设备，本插件当前只展示第一台应答的。',
    source: 'Voltide (MIT) / Logitech HID++ 2.0 公开文档',
  },
  {
    id: 'razer-91',
    name: 'Razer 91 字节 Feature 通道',
    status: 'experimental',
    transport: '2.4G',
    match: { vid: ['1532'], featureLen: 91 },
    frame:
      '91 字节 Feature：report id 0 + 90 字节 razer_report；status/tx/command class 0x07/command id 0x80；CRC = XOR(bytes[3..88])',
    parse: 'reply[0]=status（2=成功）、reply[5]=数据长度、reply[8]=充电、reply[9]=电量（>100 时按 /255*100 换算）',
    notes:
      '鼠标集合拒绝 GENERIC_READ，必须 write-only 打开并用 HidD_GetFeature 拉回复；休眠时每 120–250ms 重发才能唤醒。当前侧车还不支持 write-only，需要先补原语。',
    source: 'Voltide (MIT) / OpenRazer',
  },
  {
    id: 'rapoo-vt3s',
    name: 'RAPOO VT3S（输入上报）',
    status: 'experimental',
    transport: '2.4G',
    match: { vid: ['24AE'], pid: ['1411'], usagePage: 'FF00', usage: '0002', inLen: 19 },
    frame: '不写设备：鼠标主动推送 19 字节输入报文，report id 0x07',
    parse: 'byte[8]=电量%、byte[7]=状态（1 放电，2/3 充电）',
    notes: '需要保持句柄打开等推送；适配器用 io.listen(5s)。',
    source: 'Voltide (MIT)',
  },
  {
    id: 'xiberia-t7',
    name: '西伯利亚 XIBERIA T7 / T7 GT',
    status: 'experimental',
    transport: '2.4G',
    match: { vid: ['36F9'], pid: ['F008'], usagePage: 'FF00', inLen: 64, outLen: 64 },
    frame: '请求 64B：55 65 00 00 ...',
    parse: 'reply[3]=电量%；耳机休眠时接收器不回帧',
    notes: '协议来自官方 XIBERIA HUB 内置 ActHID.dll 的逆向。',
    source: 'Voltide (MIT)',
  },
  {
    id: 'crociris-x7',
    name: 'CROCIRIS X7 Receiver 8K',
    status: 'experimental',
    transport: '2.4G',
    match: { vid: ['36F9'], pid: ['AA20'], usagePage: 'FF0A', inLen: 65, outLen: 65 },
    frame: '请求 65B：00 AA 12 00 00 ...（report id 0 + 64 data）',
    parse: 'reply[1]=0x55、[2]=0x12、[5]=充电、[6]=电量%',
    notes: '命令接口是 0xFF0A 的 65 字节可写集合；其它标准集合不应答。',
    source: 'Voltide (MIT)',
  },
  {
    id: 'mchose-v9',
    name: 'MCHOSE V9 Turbo+ 耳机',
    status: 'experimental',
    transport: '2.4G',
    match: { vid: ['3837'], pid: ['600A'], usagePage: 'FF90', inLen: 64, outLen: 64 },
    frame: '请求 64B：55 65 01 00 ...',
    parse: 'reply[2]=电量%、reply[3]=状态（0x02 放电、0x03 充电、0x04 已充满）',
    notes: '同 VID 的 3837:6008 是灯光接口，不应答。',
    source: 'Voltide (MIT)',
  },
  {
    id: 'dareu-a950',
    name: 'DAREU A950 AIR V2',
    status: 'experimental',
    transport: '2.4G',
    match: { vid: ['260D'], pid: ['1175'], usagePage: 'FF02', inLen: 17, outLen: 17 },
    frame: '激活 08 03 ... 4A；查询 08 04 00 ×14 49',
    parse: 'reply[6]=电量%、[7]=1 充电/2 充满、[8..9]=电芯 mV（大端）',
    notes:
      '校验规则与 Compx 不同：sum(bytes[0..15]) < 0x55 ? 0x85 - sum : 0x155 - sum；零载荷查询帧与 Compx 恰好相同。WriteFile 发送。',
    source: 'Voltide (MIT)',
  },
  {
    id: 'sony-dualsense',
    name: 'Sony PS5 DualSense / Edge',
    status: 'experimental',
    transport: 'USB / 蓝牙',
    match: { vid: ['054C'], pid: ['0CE6', '0DF2'], usagePage: '0001', usage: '0005' },
    frame:
      '输入上报型：USB report 0x01（64B）状态在 offset 53；蓝牙 report 0x31（78B）状态在 offset 54，先 GET_FEATURE(0x05) 触发扩展报文',
    parse: 'status 低半字节 = 电量档（每档 10%），高半字节 = 充电状态（1 充电、2 已充满、0x0A/0B/0F 电池异常）',
    notes: '蓝牙与 USB 报文不同；适配器用 io.listen 被动接收。',
    source: 'Voltide (MIT)',
  },
  {
    id: 'eweadn-s9',
    name: '前行者 EWEADN S9 Pro',
    status: 'experimental',
    transport: '2.4G',
    match: { vid: ['372E'], pid: ['103D'], usagePage: 'FF00', featureLen: 64 },
    frame: 'Feature report 0x03：03 20 50 00 00 4F 81 00 ...',
    parse: 'reply[6]=电量%、reply[7]=状态位图（0x21 放电已观测；充电位未确认）',
    notes: 'Feature 通道，需要 SetFeature/GetFeature；官方 web driver 同款帧。',
    source: 'Voltide (MIT)',
  },
  {
    id: 'mchose-a7-ultra',
    name: 'MCHOSE A7 Ultra',
    status: 'experimental',
    transport: '2.4G / USB',
    match: { vid: ['5253'], usagePage: 'FF01', featureLen: 65 },
    frame:
      'Feature 0x11：先用 bond 命令 0x03 唤醒，再用 ost 命令 0x06 查询；等待约 50ms 后 GET_FEATURE 读取',
    parse: 'payload[9]=电量%、payload[10]=充电（0/1）、payload[8]&7=连接模式（0 USB/1 2.4G/2 蓝牙）',
    notes: '2.4G 接收器 5253:1020，USB 0011；蓝牙走 BLE GATT，不经过此协议。',
    source: 'Voltide (MIT)',
  },
  {
    id: 'eweadn-a5pro',
    name: '前行者 EWEADN A5 Pro',
    status: 'needs-capture',
    transport: '2.4G',
    match: { vid: ['258A'], pid: ['0138'], usagePage: 'FF02', usage: '0002', featureLen: 520 },
    frame: '520 字节 Feature 通道；有线模式是 0136，无线是 0138',
    parse: '电量偏移未收录，需要真机抓包',
    notes: '有线连接被官方驱动当作“充电中”（USB 连接检测，不是充电控制器状态）。',
    source: 'Voltide (MIT)',
  },
  {
    id: 'atk-n9-headset',
    name: 'ATK N9 V2 Ultimate 耳机',
    status: 'needs-capture',
    transport: '2.4G',
    match: { vid: ['373B'], pid: ['1262'], inLen: 64, outLen: 64 },
    frame: '64 字节通道，report 0x55',
    parse: '需要真机应答帧确认偏移',
    notes: '与 ATK 鼠标（0x08/0x04）不是同一套协议。',
    source: 'Voltide (MIT)',
  },
  {
    id: 'mchose-k7-a5',
    name: 'MCHOSE K7 V2 Ultra+ / A5 V3',
    status: 'needs-capture',
    transport: '2.4G',
    match: { vid: ['3837'], inLen: 64, outLen: 64 },
    frame: 'K7 V2 Ultra+ 为 64 字节；A5 V3 为 65 字节 Feature（0x11 查询 / 0x06 ost / XOR 0xFF 编码）',
    parse: 'A5 系列 payload[9]=电量、[10]=充电；K7 偏移待抓包',
    notes: '两者 VID 相同、报文长度不同，需要按集合长度区分。',
    source: 'Voltide (MIT)',
  },
  {
    id: 'asus-64',
    name: 'ROG / ASUS 64 字节',
    status: 'needs-capture',
    transport: '2.4G',
    match: { vid: ['0B05'], outLen: 64 },
    frame: '厂商自定义，Voltide 中为 64 字节帧；Omni 键鼠分离为实验性',
    parse: '需要真机应答帧',
    notes: 'ROG Delta II / Pelta 耳机走 0xFF00 的 64 字节通道。',
    source: 'Voltide (MIT)',
  },
]

/** 目录里是否有能匹配该 HID 集合的协议。 */
export function protocolsForDevice(device) {
  return PROTOCOLS.filter((protocol) => {
    const match = protocol.match
    const vids = (Array.isArray(match.vid) ? match.vid : match.vid ? [match.vid] : []).map((v) =>
      String(v).toUpperCase(),
    )
    const pids = (Array.isArray(match.pid) ? match.pid : match.pid ? [match.pid] : []).map((p) =>
      String(p).toUpperCase(),
    )
    if (vids.length > 0 && !vids.includes(device.vid)) return false
    if (pids.length > 0 && !pids.includes(device.pid)) return false
    if (match.usagePage && match.usagePage !== device.usagePage) return false
    if (match.usage && match.usage !== device.usage) return false
    if (match.inLen !== undefined && match.inLen !== device.inputLen) return false
    if (match.outLen !== undefined && match.outLen !== device.outputLen) return false
    if (match.featureLen !== undefined && match.featureLen !== device.featureLen) return false
    return true
  })
}
