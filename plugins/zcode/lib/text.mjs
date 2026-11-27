// 不由本命令写的文字（服务端给的名字、环境变量里的地址）打印之前压成一行：控制字符、行与段落分隔符、
// 改变显示方向的格式字符都换成空格，免得伪造出一行结果；截断时不切开代理对
export function plain(value) {
  const text = String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .trim()
  return Array.from(text).slice(0, 200).join('')
}

// 地址只打印协议、主机与路径：写在地址里的账号密码、查询参数不打印
export function shownUrl(url) {
  const { origin, pathname } = new URL(url)
  return plain(origin + pathname.replace(/\/+$/, ''))
}
