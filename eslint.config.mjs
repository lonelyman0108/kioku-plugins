// 全仓一份 ESLint 配置：插件的钩子是 Node 的 ES 模块；Python 的插件由 ruff 检查
import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default [
  { ignores: ['**/coverage/**', 'plugins/astrbot_plugin_kioku/**'] },
  js.configs.recommended,
  { languageOptions: { globals: globals.node } },
  // bin/kioku 没有扩展名，要列出来才检查；Node 按 CommonJS 或 ES 模块执行它都要能跑，所以按脚本的语法检查
  {
    files: ['packages/core/bin/kioku', 'plugins/*/bin/kioku'],
    languageOptions: { sourceType: 'script' },
  },
  // Prettier 负责排版：关掉所有与它冲突的格式类规则
  prettier,
]
