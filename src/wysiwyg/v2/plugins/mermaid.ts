// Milkdown Mermaid 插件：把 language=mermaid 的代码块渲染成图表
// 同时提供源码编辑模式，避免在输入过程中频繁渲染导致内容丢失

import { $view } from '@milkdown/utils'
import { codeBlockSchema } from '@milkdown/preset-commonmark'
import type { Node } from '@milkdown/prose/model'
import type { EditorView, NodeView } from '@milkdown/prose/view'
import { HighlightCodeBlockNodeView } from './highlight'

// 判断当前是否为暗色模式
function isDarkMode(): boolean {
  return (
    document.body.classList.contains('dark-mode') ||
    (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
  )
}

// 实际调用 mermaid 的渲染函数
async function renderMermaid(container: HTMLElement, code: string) {
  try {
    const mod: any = await import('mermaid')
    const mermaid = mod?.default || mod

    // 屏蔽解析错误，不要把异常抛到控制台
    try {
      ;(mermaid as any).parseError = () => {}
    } catch {}
    try {
      if ((mermaid as any).mermaidAPI) {
        ;(mermaid as any).mermaidAPI.parseError = () => {}
      }
    } catch {}

    const dark = isDarkMode()
    const theme = dark ? 'dark' : 'default'

    try {
      mermaid.initialize?.({
        startOnLoad: false,
        securityLevel: 'loose',
        theme,
        logLevel: 'fatal' as any,
        fontSize: 16 as any,
        flowchart: { useMaxWidth: true } as any,
        themeVariables: dark
          ? {
              fontFamily: 'Segoe UI, Helvetica, Arial, sans-serif',
              fontSize: '16px',
              // VS Code Dark+ 调色
              primaryColor: '#3c3c3c',
              primaryTextColor: '#d4d4d4',
              primaryBorderColor: '#505050',
              lineColor: '#808080',
              secondaryColor: '#252526',
              tertiaryColor: '#1e1e1e',
              background: '#1e1e1e',
              mainBkg: '#252526',
              secondBkg: '#1e1e1e',
              border1: '#505050',
              border2: '#3c3c3c',
              arrowheadColor: '#d4d4d4',
              textColor: '#d4d4d4',
              nodeTextColor: '#d4d4d4',
            }
          : {
              fontFamily: 'Segoe UI, Helvetica, Arial, sans-serif',
              fontSize: '16px',
            },
      })
    } catch {}

    const id = 'mmd-' + Math.random().toString(36).slice(2)
    const { svg } = await mermaid.render(id, code || '')

    container.innerHTML = ''
    const wrap = document.createElement('div')
    wrap.innerHTML = svg
    const svgEl = wrap.firstElementChild as SVGElement | null
    if (svgEl) {
      const fig = document.createElement('div')
      fig.className = 'mmd-figure'
      fig.appendChild(svgEl)
      // 挂上工具栏（导出等）
      try {
        const mk: any = (window as any).createMermaidToolsFor
        if (typeof mk === 'function') {
          const tools = mk(svgEl)
          if (tools) fig.appendChild(tools)
        }
      } catch {}
      container.appendChild(fig)
    }

    try {
      const svgEl = container.querySelector('svg') as SVGElement | null
      if (!svgEl) return

      svgEl.style.display = 'block'
      svgEl.style.maxWidth = '100%'
      svgEl.style.height = 'auto'

      if (!svgEl.getAttribute('preserveAspectRatio')) {
        svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet')
      }

      const vb = svgEl.getAttribute('viewBox') || ''
      if (!/(\d|\s)\s*(\d|\s)/.test(vb)) {
        const w = parseFloat(svgEl.getAttribute('width') || '')
        const h = parseFloat(svgEl.getAttribute('height') || '')
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
          svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`)
        }
      }

      if (svgEl.hasAttribute('width')) svgEl.removeAttribute('width')
      if (svgEl.hasAttribute('height')) svgEl.removeAttribute('height')

      setTimeout(() => {
        try {
          const bb = (svgEl as any).getBBox ? (svgEl as any).getBBox() : null
          if (!bb || bb.width <= 0 || bb.height <= 0) return
          const pad = Math.max(2, Math.min(24, Math.round(Math.max(bb.width, bb.height) * 0.02)))
          const vx = Math.floor(bb.x) - pad
          const vy = Math.floor(bb.y) - pad
          const vw = Math.ceil(bb.width) + pad * 2
          const vh = Math.ceil(bb.height) + pad * 2
          svgEl.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`)

          let scale = 0.75
          try {
            const sv = localStorage.getItem('flymd:mermaidScale')
            const n = sv ? parseFloat(sv) : NaN
            if (Number.isFinite(n) && n > 0) scale = n
          } catch {}

          const finalW = Math.max(10, Math.round(vw * scale))
          svgEl.style.width = finalW + 'px'
        } catch {}
      }, 0)
    } catch {}
  } catch (e) {
    container.innerHTML = ''
    console.error('[Mermaid Plugin] 渲染失败:', e)
  }
}

// Mermaid NodeView：源码编辑 + 图表预览
class MermaidNodeView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement | null
  private chartContainer: HTMLElement
  private preWrapper: HTMLElement
  private toolbar: HTMLElement
  private node: Node
  private view: EditorView
  private getPos: () => number | undefined

  constructor(node: Node, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.getPos = getPos

    // 外层容器
    this.dom = document.createElement('div')
    this.dom.classList.add('mermaid-node-wrapper')
    this.dom.style.margin = '1em 0'
    this.dom.style.position = 'relative'

    // 源码编辑区域：pre > code
    this.preWrapper = document.createElement('pre')
    this.preWrapper.style.display = 'none' // 默认隐藏，必要时自动进入编辑态
    this.preWrapper.style.whiteSpace = 'pre'

    this.contentDOM = document.createElement('code')
    this.preWrapper.appendChild(this.contentDOM)

    // 工具栏（当前只提供删除按钮）
    this.toolbar = document.createElement('div')
    this.toolbar.style.display = 'none'
    this.toolbar.style.textAlign = 'right'
    this.toolbar.style.marginBottom = '4px'
    const delBtn = document.createElement('button')
    delBtn.type = 'button'
    delBtn.textContent = 'Delete'
    let deleteArmed = false
    delBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      // 第一次点击进入“待确认”状态，第二次点击才真正删除
      if (!deleteArmed) {
        deleteArmed = true
        delBtn.textContent = '确认删除'
        return
      }
      this.deleteSelf()
    })
    delBtn.addEventListener('blur', () => {
      if (deleteArmed) {
        deleteArmed = false
        delBtn.textContent = 'Delete'
      }
    })
    this.toolbar.appendChild(delBtn)

    this.dom.appendChild(this.toolbar)
    this.dom.appendChild(this.preWrapper)

    // 图表展示容器
    this.chartContainer = document.createElement('div')
    this.chartContainer.classList.add('mermaid-chart-display')
    this.chartContainer.style.background = 'transparent'
    this.chartContainer.style.borderRadius = '4px'
    this.chartContainer.style.padding = '8px'
    this.chartContainer.style.minHeight = '50px'
    this.chartContainer.style.cursor = 'pointer'
    this.chartContainer.textContent = '(空 mermaid 图表)'

    // 双击图表进入源码编辑模式
    this.chartContainer.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      e.preventDefault()
      this.enterEditMode()
    })

    // Escape 退出源码编辑模式
    this.preWrapper.addEventListener('keydown', (e) => {
      const kev = e as KeyboardEvent
      if (kev.key === 'Escape') {
        kev.preventDefault()
        kev.stopPropagation()
        this.exitEditMode()
      }
    })

    // 点击容器外部时自动退出源码编辑模式
    document.addEventListener('click', this.handleClickOutside)

    this.dom.appendChild(this.chartContainer)

    // 新建 mermaid 代码块：如果当前没有任何代码，自动进入源码编辑模式（` ```mermaid 回车` 的场景）
    const initialCode = this.getCodeFromNode()
    if (!initialCode.trim()) {
      this.enterEditMode(false)
    } else {
      // 已经有内容（从 Markdown 打开等），直接渲染图表
      this.renderChart()
    }
  }

  // 是否处于源码编辑模式
  private isEditingSource(): boolean {
    return this.preWrapper.style.display !== 'none'
  }

  // 从 Milkdown 节点读取源码
  private getCodeFromNode(): string {
    return String(this.node.textContent || '')
  }

  // 进入源码编辑模式
  private enterEditMode(focusEnd: boolean = true) {
    this.preWrapper.style.display = 'block'
    const dark = isDarkMode()
    this.preWrapper.style.border = dark ? '1px solid #3c3c3c' : '1px solid #ccc'
    this.preWrapper.style.padding = '8px'
    this.preWrapper.style.borderRadius = '4px'
    this.preWrapper.style.background = dark ? '#1e1e1e' : '#fff'
    this.preWrapper.style.color = dark ? '#d4d4d4' : '#1e1e1e'

    this.chartContainer.style.display = 'none'
    this.toolbar.style.display = 'block'

    // 聚焦到源码区域末尾，方便继续输入
    if (focusEnd && this.contentDOM) {
      requestAnimationFrame(() => {
        try {
          const range = document.createRange()
          const sel = window.getSelection()
          range.selectNodeContents(this.contentDOM as HTMLElement)
          range.collapse(false)
          sel?.removeAllRanges()
          sel?.addRange(range)
          ;(this.contentDOM as HTMLElement).focus()
        } catch {}
      })
    }
  }

  // 退出源码编辑模式并重新渲染图表
  private exitEditMode() {
    if (!this.isEditingSource()) return
    this.preWrapper.style.display = 'none'
    this.chartContainer.style.display = 'block'
    this.toolbar.style.display = 'none'
    // 离开编辑区后再渲染，避免在输入过程中一行一行地重绘
    requestAnimationFrame(() => {
      this.renderChart()
    })
  }

  // 渲染 Mermaid 图表（仅在非编辑模式时调用）
  private async renderChart() {
    if (this.isEditingSource()) {
      // 正在编辑源码时不渲染，等用户退出编辑模式
      return
    }

    const code = this.getCodeFromNode()
    if (!code || !code.trim()) {
      this.chartContainer.textContent = '(空 mermaid 图表)'
      return
    }

    this.chartContainer.textContent = '渲染中...'
    try {
      await renderMermaid(this.chartContainer, code)
    } catch (e) {
      console.error('[Mermaid Plugin] 渲染出错:', e)
      this.chartContainer.textContent = '渲染失败'
    }
  }

  update(node: Node) {
    if (node.type !== this.node.type) return false

    const oldCode = this.node.textContent
    const newCode = node.textContent

    this.node = node

    // 源码变化时：
    if (oldCode !== newCode) {
      // 非编辑模式下立即重新渲染；编辑模式下等退出再统一渲染
      if (!this.isEditingSource()) {
        this.renderChart()
      }
    }

    return true
  }

  destroy() {
    try {
      document.removeEventListener('click', this.handleClickOutside)
    } catch {}
  }

  // 点击节点外部时退出源码编辑模式
  private handleClickOutside = (e: Event) => {
    if (!this.isEditingSource()) return
    const target = e.target as HTMLElement
    if (!this.dom.contains(target)) {
      this.exitEditMode()
    }
  }

  // Mutation 过滤：源码区域必须让 ProseMirror 处理，图表/工具栏变化可以忽略
  ignoreMutation(mutation: MutationRecord) {
    if (mutation.target === this.chartContainer || this.chartContainer.contains(mutation.target as globalThis.Node)) {
      return true
    }
    if (mutation.target === this.toolbar || this.toolbar.contains(mutation.target as globalThis.Node)) {
      return true
    }
    if (!this.contentDOM) return false
    if (mutation.target === this.contentDOM || this.contentDOM.contains(mutation.target as globalThis.Node)) {
      // 源码编辑区域：必须交给 ProseMirror，同步到文档
      return false
    }
    return false
  }

  // 删除当前 mermaid 节点
  private deleteSelf() {
    try {
      const pos = this.getPos?.()
      if (typeof pos !== 'number') return
      const { state, dispatch } = this.view
      const from = pos
      const to = pos + this.node.nodeSize
      dispatch(state.tr.delete(from, to).scrollIntoView())
    } catch {}
  }
}

// 创建 mermaid 插件：language=mermaid 用 MermaidNodeView，其它代码块用高亮 NodeView
export const mermaidPlugin = $view(codeBlockSchema.node, () => {
  return (node, view, getPos) => {
    const lang = String(node.attrs.language || '').toLowerCase()
    if (lang === 'mermaid') {
      return new MermaidNodeView(node, view, getPos as () => number | undefined)
    }
    return new HighlightCodeBlockNodeView(node, view, getPos as () => number | undefined)
  }
})
