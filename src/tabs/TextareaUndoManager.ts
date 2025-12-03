/**
 * 文本区域撤销管理器
 *
 * 目标：
 * - 为每个标签维护独立的撤销/重做栈
 * - 只在源码模式且焦点在 textarea 时接管 Ctrl+Z / Ctrl+Y
 * - 不修改 TabManager / main.ts，对现有行为最小侵入
 */

interface EditRecord {
  content: string
  selectionStart: number
  selectionEnd: number
  timestamp: number
}

interface ManualUndoStack {
  undoStack: EditRecord[]
  redoStack: EditRecord[]
  maxSize: number
}

export class TextareaUndoManager {
  private stacks = new Map<string, ManualUndoStack>()
  private currentTabId: string | null = null
  private textarea: HTMLTextAreaElement | null = null

  private inputHandler?: (e: Event) => void
  private keydownHandler?: (e: KeyboardEvent) => void

  // 标记：正在应用撤销/重做，避免死循环
  private isApplying = false
  // 标记：外部程序性更新（如切换标签、打开文件），不记录到撤销栈
  private suppressRecording = false

  /**
   * 初始化当前激活标签的撤销栈
   * 等价于第一次 switchTab
   */
  init(tabId: string, textarea: HTMLTextAreaElement): void {
    this.switchTab(tabId, textarea)
  }

  /**
   * 切换到指定标签的撤销栈
   * 不丢弃其他标签的栈，只是更换当前激活的栈
   */
  switchTab(tabId: string, textarea: HTMLTextAreaElement): void {
    // 解绑旧监听器，但保留历史栈
    this.cleanupListeners()

    this.currentTabId = tabId
    this.textarea = textarea

    // 为该标签创建撤销栈（如果还没有）
    let stack = this.stacks.get(tabId)
    const contentSize = textarea.value.length
    if (!stack) {
      const maxSize = contentSize > 500_000 ? 15 : 30
      stack = { undoStack: [], redoStack: [], maxSize }
      this.stacks.set(tabId, stack)

      if (contentSize > 500_000) {
        const kb = (contentSize / 1024).toFixed(1)
        console.debug(
          `[UndoManager] Large doc detected (${kb}KB), limiting stack to ${maxSize} records`
        )
      }
    }

    // 绑定新 textarea 的监听器
    this.bindListeners(textarea)

    // 首次使用该标签时，记录一个初始状态
    if (stack.undoStack.length === 0) {
      this.recordEdit()
    } else {
      // 如果当前内容和栈顶不一致，也追加一条状态作为新的基线
      const top = stack.undoStack[stack.undoStack.length - 1]
      if (
        top.content !== textarea.value ||
        top.selectionStart !== textarea.selectionStart ||
        top.selectionEnd !== textarea.selectionEnd
      ) {
        this.recordEdit()
      }
    }
  }

  /**
   * 移除指定标签的撤销栈（标签关闭时调用）
   */
  removeTab(tabId: string): void {
    this.stacks.delete(tabId)
    if (this.currentTabId === tabId) {
      this.currentTabId = null
      this.cleanupListeners()
    }
  }

  /**
   * 在一次外部程序性更新期间暂停记录撤销快照
   * 例如：切换标签、打开文件时设置 textarea.value
   */
  runWithoutRecording(fn: () => void): void {
    const prev = this.suppressRecording
    this.suppressRecording = true
    try {
      fn()
    } finally {
      this.suppressRecording = prev
    }
  }

  /**
   * 执行撤销
   */
  undo(): void {
    if (!this.currentTabId) return
    const stack = this.stacks.get(this.currentTabId)
    if (!stack) return
    if (stack.undoStack.length <= 1) return // 至少保留一个基线状态

    const current = stack.undoStack.pop()!
    stack.redoStack.push(current)

    const prev = stack.undoStack[stack.undoStack.length - 1]
    this.applyRecord(prev)
  }

  /**
   * 执行重做
   */
  redo(): void {
    if (!this.currentTabId) return
    const stack = this.stacks.get(this.currentTabId)
    if (!stack) return
    if (stack.redoStack.length === 0) return

    const next = stack.redoStack.pop()!
    stack.undoStack.push(next)

    this.applyRecord(next)
  }

  /**
   * 绑定 textarea 的输入/按键监听
   */
  private bindListeners(textarea: HTMLTextAreaElement): void {
    this.inputHandler = () => {
      if (this.isApplying || this.suppressRecording) return
      this.recordEdit()
    }

    this.keydownHandler = (e: KeyboardEvent) => {
      // 只在源码模式 + 焦点在 textarea 时接管
      const flymd = (window as any) ?? {}
      const isEditMode = flymd.flymdGetMode?.() === 'edit'
      if (!isEditMode) return
      if (document.activeElement !== textarea) return

      const isCtrlOrMeta = e.ctrlKey || e.metaKey
      if (!isCtrlOrMeta) return

      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        this.undo()
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        this.redo()
      }
    }

    textarea.addEventListener('input', this.inputHandler)
    textarea.addEventListener('keydown', this.keydownHandler)
  }

  /**
   * 解绑 textarea 监听器，但保留所有撤销栈
   */
  private cleanupListeners(): void {
    if (this.textarea && this.inputHandler) {
      this.textarea.removeEventListener('input', this.inputHandler)
    }
    if (this.textarea && this.keydownHandler) {
      this.textarea.removeEventListener('keydown', this.keydownHandler)
    }

    this.inputHandler = undefined
    this.keydownHandler = undefined
    this.textarea = null
  }

  /**
   * 记录一次编辑快照
   * 使用时间窗口合并策略 + 栈深度限制控制内存占用
   */
  private recordEdit(): void {
    if (!this.currentTabId || !this.textarea) return

    const stack = this.stacks.get(this.currentTabId)
    if (!stack) return

    const now = Date.now()
    const record: EditRecord = {
      content: this.textarea.value,
      selectionStart: this.textarea.selectionStart,
      selectionEnd: this.textarea.selectionEnd,
      timestamp: now,
    }

    const undoStack = stack.undoStack
    const last = undoStack[undoStack.length - 1]

    const contentSize = record.content.length
    const mergeWindow = contentSize > 500_000 ? 2000 : 800

    if (last && now - last.timestamp < mergeWindow) {
      // 合并：替换最后一条记录
      undoStack[undoStack.length - 1] = record
    } else {
      // 新增记录
      undoStack.push(record)

      // 栈满时丢弃最旧记录（FIFO）
      if (undoStack.length > stack.maxSize) {
        undoStack.shift()
      }
    }

    // 用户输入后，重做栈失效
    stack.redoStack = []

    // 栈满时打印估算内存
    if (undoStack.length === stack.maxSize) {
      const memUsage = (record.content.length * stack.maxSize / 1024).toFixed(1)
      console.debug(
        `[UndoManager] Stack full for tab ${this.currentTabId.slice(0, 8)}, ` +
        `estimated memory: ${memUsage}KB`
      )
    }
  }

  /**
   * 应用某条历史记录到 textarea
   * 会触发 input 事件通知其他监听器，但不会被再次记录到撤销栈
   */
  private applyRecord(record: EditRecord): void {
    if (!this.textarea) return

    this.isApplying = true
    try {
      this.textarea.value = record.content
      this.textarea.setSelectionRange(record.selectionStart, record.selectionEnd)

      // 派发 input 事件，让 dirty 标记、预览等逻辑保持工作
      const ev = new Event('input', { bubbles: true })
      this.textarea.dispatchEvent(ev)
    } finally {
      this.isApplying = false
    }
  }
}

