//! DSH Host 侧的 daemon 客户端：常驻 sidecar 的 JSON-lines RPC。
//!
//! 负责：按需 spawn、请求关联、超时、空闲退出后的重启、插件卸载时清理。

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export class DaemonClient {
  constructor({ exePath, idleSeconds = 900, requestTimeoutMs = 15_000 }) {
    this.exePath = exePath
    this.idleSeconds = idleSeconds
    this.requestTimeoutMs = requestTimeoutMs
    this.child = null
    this.pending = new Map()
    this.nextId = 1
    this.lastStderr = ''
    this.disposed = false
    this.onEvent = null
  }

  ensureChild() {
    if (this.disposed) throw new Error('daemon client 已释放')
    if (this.child) return this.child

    const child = spawn(this.exePath, ['--idle-seconds', String(this.idleSeconds)], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child

    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => this.onLine(line))

    child.stderr.on('data', (chunk) => {
      this.lastStderr = `${this.lastStderr}${chunk}`.slice(-2000)
    })

    // daemon 退出或重启时，stdin 写入可能拿到 EPIPE；没有这个监听会变成进程级未捕获异常。
    child.stdin.on('error', (error) => {
      if (this.child !== child) return
      this.child = null
      this.failAll(`daemon stdin 错误：${error.message}`)
    })

    child.on('error', (error) => {
      if (this.child !== child) return
      this.child = null
      this.failAll(`daemon 启动失败：${error.message}`)
    })

    child.on('exit', () => {
      if (this.child !== child) return
      this.child = null
      this.failAll(this.lastStderr ? `daemon 退出：${this.lastStderr}` : 'daemon 已退出')
    })

    return child
  }

  onLine(line) {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    // 主动事件没有 id：设备到达/移除时 daemon 会推一行。
    if (message.id === undefined && typeof message.event === 'string') {
      try {
        this.onEvent?.(message)
      } catch {
        // 事件处理失败不影响 RPC。
      }
      return
    }
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.ok) {
      entry.resolve(message.result)
    } else {
      const error = new Error(message.error?.message || 'daemon 返回失败')
      error.code = message.error?.code || 'daemon_error'
      entry.reject(error)
    }
  }

  failAll(reason) {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      clearTimeout(entry.timer)
      const error = new Error(reason)
      error.code = 'daemon_exited'
      entry.reject(error)
    }
  }

  async request(cmd, payload = {}, timeoutMs = this.requestTimeoutMs) {
    const child = this.ensureChild()
    const id = this.nextId++
    const line = JSON.stringify({ id, cmd, ...payload })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const error = new Error(`daemon 命令 ${cmd} 超时`)
        error.code = 'timeout'
        reject(error)
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${line}\n`, (error) => {
        if (!error) return
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  async restart() {
    const old = this.child
    this.child = null
    this.failAll('daemon 正在重启')
    if (old) {
      try {
        old.kill()
      } catch {
        // 旧进程可能已退出。
      }
    }
    const pong = await this.request('ping', {})
    return { pid: this.child?.pid || null, ...pong }
  }

  async health() {
    if (!this.child) return { running: false, pid: null, version: null, error: null }
    try {
      const pong = await this.request('ping', {})
      return {
        running: true,
        pid: this.child?.pid || null,
        version: pong?.version || null,
        error: null,
      }
    } catch (error) {
      return {
        running: false,
        pid: this.child?.pid || null,
        version: null,
        error: String(error?.message ?? error),
      }
    }
  }

  dispose() {
    this.disposed = true
    this.failAll('daemon client 已释放')
    const child = this.child
    this.child = null
    if (!child) return
    try {
      child.stdin.end()
    } catch {
      // ignore
    }
    try {
      child.kill()
    } catch {
      // ignore
    }
  }
}
