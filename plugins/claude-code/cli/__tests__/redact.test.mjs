import { describe, expect, it } from 'vitest'

import { createRedactor } from '../redact.mjs'

// 把几块数据依次写进打码的流，返回读出来的全部字节
async function redact(values, chunks) {
  const redactor = createRedactor(values)
  const out = []
  redactor.on('data', (chunk) => out.push(chunk))
  const ended = new Promise((resolve) => redactor.once('end', resolve))
  for (const chunk of chunks) redactor.write(chunk)
  redactor.end()
  await ended
  return Buffer.concat(out)
}

const text = async (values, chunks) => (await redact(values, chunks)).toString()
const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('打码', () => {
  it('输出里原样出现的值换成 ***', async () => {
    expect(await text(['hunter-22'], ['密码是 hunter-22，别外传 hunter-22\n'])).toBe(
      '密码是 ***，别外传 ***\n',
    )
  })

  it('值被拆在两块里也换掉', async () => {
    expect(await text(['hunter-22'], ['pass=hun', 'ter-22 ok'])).toBe('pass=*** ok')
    // 一个字节一块
    const bytes = [...Buffer.from('a hunter-22 b')].map((b) => Buffer.from([b]))
    expect(await text(['hunter-22'], bytes)).toBe('a *** b')
  })

  it('多个值各自换掉，同一个值给了几次也一样', async () => {
    expect(
      await text(['alpha-01', 'beta-022', 'alpha-01'], ['a=alpha-01 b=beta-0', '22 c=alpha-01']),
    ).toBe('a=*** b=*** c=***')
  })

  it('值互相包含时按长的换，重叠的一起盖住', async () => {
    expect(await text(['secret', 'secret-123'], ['a secret-123 b secret c'])).toBe('a *** b *** c')
    expect(await text(['abcdef', 'defghi'], ['x abcdefghi y'])).toBe('x *** y')
    // 重叠的两次出现跨过了块的边界
    expect(await text(['abcdef', 'defghi'], ['x abcde', 'fghi y'])).toBe('x *** y')
    // 值自己的结尾又是它的开头：留着的那段接上下一块，不论有没有再出现一次，都只写一个 ***
    expect(await text(['abcab'], ['> abcab', 'cab!'])).toBe('> ***!')
    expect(await text(['abcab'], ['> abcab', 'xyz'])).toBe('> ***xyz')
  })

  it('少于 4 个字符的值不打码', async () => {
    expect(await text(['abc', '密码', 'abcd'], ['abc 密码 abcd'])).toBe('abc 密码 ***')
  })

  it('按字节比对：多字节字符被拆在两块里也照样换掉，别的字符原样通过', async () => {
    const value = '甲乙丙丁'
    const input = Buffer.from(`前缀：${value}，后缀`)
    const bytes = [...input].map((b) => Buffer.from([b]))
    expect(await text([value], bytes)).toBe('前缀：***，后缀')
    // 拆在值里一个字符的中间，以及值外面一个字符的中间
    const inside = Buffer.from('前缀：甲').length + 1
    expect(await text([value], [input.subarray(0, inside), input.subarray(inside)])).toBe(
      '前缀：***，后缀',
    )
    expect(await text([value], [input.subarray(0, 4), input.subarray(4)])).toBe('前缀：***，后缀')
  })

  it('不是 UTF-8 的输出原样通过', async () => {
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0xe4, 0xb8, 0x6f, 0x6b])
    expect(await redact(['secret-value'], [binary.subarray(0, 3), binary.subarray(3)])).toEqual(
      binary,
    )
  })

  it('块的结尾不像值的开头时立刻写出，像的话只留那一段，结束时冲刷出去', async () => {
    const redactor = createRedactor(['secret-value'])
    let out = ''
    redactor.on('data', (chunk) => (out += chunk))
    const ended = new Promise((resolve) => redactor.once('end', resolve))
    redactor.write('就绪\n')
    await tick()
    expect(out).toBe('就绪\n')
    redactor.write('abc sec')
    await tick()
    expect(out).toBe('就绪\nabc ')
    redactor.end()
    await ended
    expect(out).toBe('就绪\nabc sec')
  })

  it('没有要打码的值时原样通过', async () => {
    expect(await text([], ['原样'])).toBe('原样')
    expect(await text(['abc'], ['abc'])).toBe('abc')
  })
})
