// 适配器目录：市场条目、factory builtIn、已安装记录与设备匹配的唯一投影。
// 纯函数模块；文件/网络留在 Host。

export function entryView(entry, { installed = {}, builtIn = new Set() } = {}) {
  return {
    id: entry.id,
    name: entry.name,
    model: entry.model,
    connection: entry.connection,
    kind: entry.kind,
    transport: entry.transport,
    match: entry.match,
    author: entry.author,
    status: entry.status,
    notes: entry.notes,
    file: entry.file,
    builtIn: builtIn.has(entry.id),
    installed: Boolean(installed[entry.id]),
  }
}

export function searchEntries(entries, query, { installed = {}, builtIn = new Set() } = {}) {
  const needle = String(query || '').trim().toLowerCase()
  return entries
    .filter((entry) => {
      if (!needle) return true
      const haystack = [entry.id, entry.name, entry.model].join(' ').toLowerCase()
      return haystack.includes(needle)
    })
    .map((entry) => entryView(entry, { installed, builtIn }))
}

export function matchEntry(entry, device) {
  const match = entry.match
  if (!match) return false
  if (!match.vids.includes(device.vid)) return false
  if (match.pids.length > 0 && !match.pids.includes(device.pid)) return false
  if (match.usagePage && device.usagePage && match.usagePage !== device.usagePage) return false
  if (match.usage && device.usage && match.usage !== device.usage) return false
  if (match.inLen !== undefined && device.inLen !== undefined && match.inLen !== device.inLen) {
    return false
  }
  if (match.outLen !== undefined && device.outLen !== undefined && match.outLen !== device.outLen) {
    return false
  }
  if (
    match.featureLen !== undefined &&
    device.featureLen !== undefined &&
    match.featureLen !== device.featureLen
  ) {
    return false
  }
  return true
}

export function matchEntries(entries, device, { installed = {}, builtIn = new Set() } = {}) {
  return entries
    .filter((entry) => matchEntry(entry, device))
    .map((entry) => entryView(entry, { installed, builtIn }))
}
