// 不由本命令写的文字（服务端给的名字、环境变量里的地址）打印之前压成一行：控制字符、行与段落分隔符、
// 改变显示方向的格式字符都换成空格，免得伪造出一行结果；截断时不切开代理对
export function plain(value) {
  const text = String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .trim()
  return Array.from(text).slice(0, 200).join('')
}
