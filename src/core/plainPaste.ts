// 纯文本粘贴核心逻辑（编辑器 / 预览 / 所见模式共用）
// 不直接依赖全局 editor / mode，由调用方注入环境，保持模块独立

export type PlainPasteEnv = {
  insertAtCursor: (text: string) => void
  isPreviewMode: () => boolean
  isWysiwygMode: () => boolean
  renderPreview: () => Promise<void>
  scheduleWysiwygRender: () => void
}

export async function applyPlainTextPaste(text: string, env: PlainPasteEnv): Promise<void> {
  if (!text) return
  env.insertAtCursor(text)
  try {
    if (env.isPreviewMode()) {
      await env.renderPreview()
    } else if (env.isWysiwygMode()) {
      env.scheduleWysiwygRender()
    }
  } catch {}
}

