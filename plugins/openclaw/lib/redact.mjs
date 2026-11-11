// 打码：输出里原样出现的值换成 ***。按字节比对、不解码，所以不会把一个字符拆开，
// 不是 UTF-8 的输出（例如二进制）也原样通过。只防值顺手出现在输出里，不是安全边界：
// 值被编码、拆开或改了大小写后再打印，就认不出来

import { PassThrough, Transform } from 'node:stream'

const MASK = Buffer.from('***')

// 少于这么多个字符的值不打码：这么短的串在输出里到处都是，换掉会误伤
export const MIN_REDACT_CHARS = 4

export function redactable(value) {
  return [...value].length >= MIN_REDACT_CHARS
}

// buf 的结尾是某个值的开头（一次还没写完的出现）时，返回这一段的长度，否则为 0
function partialTail(buf, needles) {
  let longest = 0
  for (const needle of needles) {
    // 从最长的可能找起，第一个对上的就是这个值能留下的最长一段
    for (let at = Math.max(0, buf.length - needle.length + 1); at < buf.length; at++) {
      const length = buf.length - at
      if (length <= longest) break
      if (buf[at] === needle[0] && buf.subarray(at).equals(needle.subarray(0, length))) {
        longest = length
        break
      }
    }
  }
  return longest
}

// 返回一个 Transform：写进去原始输出，读出来打过码的输出。
// 值可能被拆在相邻的两块里：块的结尾像某个值的开头时，这一段先留着，拼上下一块再判断，结束时冲刷出去。
// 几个值互相包含或重叠时，盖住的范围取并集，连成一片的只写一个 ***
export function createRedactor(values) {
  const needles = [...new Set(values.filter(redactable))].map((v) => Buffer.from(v, 'utf8'))
  if (needles.length === 0) return new PassThrough()
  let pending = Buffer.alloc(0)
  // pending 开头已经确定盖住的字节数：上一次写出的最后一段延续到了这里
  let carry = 0
  // 上一次写出的最后一个字节盖住了没有：盖住的话，从 pending 开头接着盖的部分不再另写 ***
  let covered = false

  function drain(final) {
    const limit = final ? pending.length : pending.length - partialTail(pending, needles)
    if (limit <= 0) return null
    // [0, limit) 里每个字节盖不盖住都已经定了：盖住它的出现都从 limit 之前开始，而且都完整地在 pending 里
    const ranges = carry > 0 ? [[0, carry]] : []
    for (const needle of needles) {
      for (
        let at = pending.indexOf(needle);
        at !== -1 && at < limit;
        at = pending.indexOf(needle, at + 1)
      ) {
        ranges.push([at, at + needle.length])
      }
    }
    ranges.sort((a, b) => a[0] - b[0])
    const runs = []
    for (const [from, to] of ranges) {
      const last = runs.at(-1)
      if (last && from <= last[1]) last[1] = Math.max(last[1], to)
      else runs.push([from, to])
    }
    const parts = []
    let pos = 0
    for (const [from, to] of runs) {
      if (from > pos) parts.push(pending.subarray(pos, from))
      if (from > 0 || !covered) parts.push(MASK)
      pos = Math.min(to, limit)
    }
    if (pos < limit) parts.push(pending.subarray(pos, limit))
    const reach = runs.length > 0 ? runs.at(-1)[1] : 0
    covered = reach >= limit
    carry = Math.max(0, reach - limit)
    pending = pending.subarray(limit)
    return Buffer.concat(parts)
  }

  const emit = (callback, out) => callback(null, out?.length ? out : undefined)
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk
      emit(callback, drain(false))
    },
    flush(callback) {
      emit(callback, drain(true))
    },
  })
}
