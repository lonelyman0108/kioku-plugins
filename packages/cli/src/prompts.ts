// 向导的交互层统一导出（底层实现在 ./ui/prompts.ts）

export {
  CANCEL,
  createBuiltinPrompts,
  formatCountdown,
  isCancel,
  loadPrompts,
  localized,
  nodeSupported,
  renderDeviceAuthBox,
  spacedCode,
  startDeviceAuthWait,
  type ConfirmConfig,
  type DeviceWaitHandle,
  type MultiselectConfig,
  type PasswordConfig,
  type PromptsUi,
  type SelectConfig,
  type SelectOption,
  type SpinnerHandle,
  type TextConfig,
} from './ui/prompts.ts'
