import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATE = path.join(ROOT, 'templates', 'adapter-template.js')
const args = process.argv.slice(2)
const toUser = args.includes('--user')
const positional = args.filter((arg) => arg !== '--user')
const rawId = positional[0]
const rawName = positional.slice(1).join(' ').trim()

function die(message) {
  console.error(message)
  console.error('用法：node scripts/new-adapter.mjs <id> [name] [--user]')
  process.exit(1)
}

if (!rawId) die('缺少适配器 id')
if (!/^[A-Za-z0-9._-]{1,64}$/.test(rawId)) die('id 只能包含字母、数字、点、下划线、连字符，长度 1–64')

const name = (rawName || rawId).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
const directory = toUser
  ? path.join(
      process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local'),
      'dsh-peripheral-battery',
      'adapters',
    )
  : path.join(ROOT, 'adapters')
const target = path.join(directory, `${rawId}.js`)

if (!existsSync(TEMPLATE)) die(`缺少模板：${TEMPLATE}`)
if (existsSync(target)) die(`文件已存在：${target}`)

mkdirSync(directory, { recursive: true })
const source = readFileSync(TEMPLATE, 'utf8')
  .replaceAll('__ID__', rawId)
  .replaceAll('__NAME__', name)
writeFileSync(target, source, 'utf8')

console.log(`已生成：${target}`)
console.log('下一步：修改 match / read(io)，然后运行 npm run check:adapters')
if (toUser) {
  console.log('在对话里执行 battery_adapters({ action: "reload" }) 使适配器生效。')
} else {
  console.log('这是 factory 适配器；提交前确保有真机验证和协议出处。')
}
