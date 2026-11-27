import { defineConfig } from 'vitest/config'

// 插件包没有自己的依赖目录，不指定的话会和别的包共用工作区根目录下的缓存，
// 并行跑测试时互相清理，偶尔启动失败
export default defineConfig({ cacheDir: 'node_modules/.vite' })
