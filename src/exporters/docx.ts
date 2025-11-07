// src/exporters/docx.ts
// 使用 html-docx-js（UMD 全局）将 HTML/Element 导出为 DOCX 字节，动态加载 public/vendor/html-docx.js，避免打包器兼容问题

async function ensureHtmlDocx(): Promise<any> {
  const g: any = (globalThis as any)
  if (g.htmlDocx && typeof g.htmlDocx.asBlob === 'function') return g.htmlDocx
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = '/vendor/html-docx.js'
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('加载 html-docx.js 失败'))
    document.head.appendChild(script)
  })
  const g2: any = (globalThis as any)
  if (!g2.htmlDocx || typeof g2.htmlDocx.asBlob !== 'function') throw new Error('htmlDocx 未就绪')
  return g2.htmlDocx
}

// 从 Tauri 读取本地文件为 dataURL
async function readLocalAsDataUrl(absPath: string): Promise<string> {
  try {
    const { readFile } = await import('@tauri-apps/plugin-fs')
    const bytes = await readFile(absPath as any)
    const mime = (() => {
      const m = (absPath || '').toLowerCase().match(/\.([a-z0-9]+)$/)
      switch (m?.[1]) {
        case 'jpg':
        case 'jpeg': return 'image/jpeg'
        case 'png': return 'image/png'
        case 'gif': return 'image/gif'
        case 'webp': return 'image/webp'
        case 'bmp': return 'image/bmp'
        case 'avif': return 'image/avif'
        case 'svg': return 'image/svg+xml'
        case 'ico': return 'image/x-icon'
        default: return 'application/octet-stream'
      }
    })()
    const blob = new Blob([bytes], { type: mime })
    const dataUrl = await new Promise<string>((resolve, reject) => {
      try {
        const fr = new FileReader()
        fr.onerror = () => reject(fr.error || new Error('读取失败'))
        fr.onload = () => resolve(String(fr.result || ''))
        fr.readAsDataURL(blob)
      } catch (e) { reject(e as any) }
    })
    return dataUrl
  } catch (e) {
    console.warn('readLocalAsDataUrl 失败', e)
    return ''
  }
}

// 通过 Tauri HTTP 客户端抓取远程图片（避免 CORS），必要时转为 PNG
async function fetchRemoteAsDataUrl(url: string): Promise<string> {
  // 1) 优先使用 Tauri v2 http 插件（不受浏览器 CORS 限制）
  try {
    const mod: any = await import('@tauri-apps/plugin-http')
    if (mod?.fetch) {
      const resp = await mod.fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'image/*;q=0.9,*/*;q=0.1' },
      })
      const ab: ArrayBuffer = await resp.arrayBuffer()
      let mime = 'application/octet-stream'
      try {
        const ct = resp.headers?.get?.('content-type') || resp.headers?.get?.('Content-Type')
        if (ct) mime = String(ct).split(';')[0].trim()
      } catch {}
      if (!/^image\//i.test(mime)) {
        const m = (url || '').toLowerCase().match(/\.([a-z0-9]+)(?:\?|#|$)/)
        switch (m?.[1]) {
          case 'jpg':
          case 'jpeg': mime = 'image/jpeg'; break
          case 'png': mime = 'image/png'; break
          case 'gif': mime = 'image/gif'; break
          case 'webp': mime = 'image/webp'; break
          case 'bmp': mime = 'image/bmp'; break
          case 'avif': mime = 'image/avif'; break
          case 'svg': mime = 'image/svg+xml'; break
          case 'ico': mime = 'image/x-icon'; break
        }
      }
      let blob = new Blob([ab], { type: mime })
      // Word 兼容性：将 webp/avif/svg 转为 PNG
      if (/^(image\/webp|image\/avif|image\/svg\+xml)$/i.test(mime)) {
        try {
          const url2 = URL.createObjectURL(blob)
          try {
            const pngUrl: string = await new Promise((resolve, reject) => {
              const img = new Image()
              img.onload = () => {
                try {
                  const canvas = document.createElement('canvas')
                  canvas.width = img.naturalWidth || img.width || 1
                  canvas.height = img.naturalHeight || img.height || 1
                  const ctx = canvas.getContext('2d')!
                  ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height)
                  ctx.drawImage(img, 0, 0)
                  resolve(canvas.toDataURL('image/png'))
                } catch (e) { reject(e) }
              }
              img.onerror = () => reject(new Error('图片加载失败'))
              img.src = url2
            })
            return pngUrl
          } finally { URL.revokeObjectURL(url2) }
        } catch (e) { console.warn('转 PNG 失败，使用原格式', e) }
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        try {
          const fr = new FileReader()
          fr.onerror = () => reject(fr.error || new Error('读取失败'))
          fr.onload = () => resolve(String(fr.result || ''))
          fr.readAsDataURL(blob)
        } catch (e) { reject(e as any) }
      })
      return dataUrl
    }
  } catch (e) {
    console.warn('plugin-http 不可用，回退 window.fetch', e)
  }
  // 2) 回退：window.fetch（需要后端允许 CORS）
  try {
    const r = await fetch(url, { mode: 'cors' })
    const blob = await r.blob()
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader()
      fr.onerror = () => reject(fr.error || new Error('读取失败'))
      fr.onload = () => resolve(String(fr.result || ''))
      fr.readAsDataURL(blob)
    })
    return dataUrl
  } catch (e2) {
    console.error('window.fetch 回退也失败', e2)
    return ''
  }
}

async function svgToPngDataUrl(svgEl: SVGElement): Promise<string> {
  try {
    const serializer = new XMLSerializer()
    const svgStr = serializer.serializeToString(svgEl)
    const viewBox = svgEl.getAttribute('viewBox')
    let width = Number(svgEl.getAttribute('width')) || 0
    let height = Number(svgEl.getAttribute('height')) || 0
    if ((!width || !height) && viewBox) {
      const parts = viewBox.split(/\s+/).map(Number)
      if (parts.length === 4) { width = parts[2]; height = parts[3] }
    }
    if (!width || !height) {
      width = (svgEl as any).clientWidth || 800
      height = (svgEl as any).clientHeight || 600
    }
    const svgBlob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(svgBlob)
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
          try {
            const ratio = img.width > 0 ? Math.min(1, 2000 / img.width) : 1
            const cw = Math.max(1, Math.round(img.width * ratio))
            const ch = Math.max(1, Math.round(img.height * ratio))
            const canvas = document.createElement('canvas')
            canvas.width = cw; canvas.height = ch
            const ctx = canvas.getContext('2d')!
            ctx.fillStyle = '#fff'; ctx.fillRect(0,0,cw,ch)
            ctx.drawImage(img, 0, 0, cw, ch)
            resolve(canvas.toDataURL('image/png'))
          } catch (e) { reject(e) }
        }
        img.onerror = () => reject(new Error('svg -> png 加载失败'))
        img.src = url
      })
      return dataUrl
    } catch (e) {
      try { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr) } catch { return '' }
    } finally {
      URL.revokeObjectURL(url)
    }
  } catch (e) {
    console.error('svgToPngDataUrl 失败', e)
    return ''
  }
}

async function preprocessElementForDocx(el: HTMLElement): Promise<string> {
  const clone = el.cloneNode(true) as HTMLElement

  // 1) SVG -> PNG IMG（失败则用 SVG dataURL）
  try {
    const svgsSrc = Array.from(el.querySelectorAll('svg')) as SVGElement[]
    const dataList = await Promise.all(svgsSrc.map(svgToPngDataUrl))
    const svgsClone = Array.from(clone.querySelectorAll('svg')) as Element[]
    for (let i = 0; i < svgsClone.length && i < dataList.length; i++) {
      const url = dataList[i]
      const img = document.createElement('img')
      if (url) img.src = url
      const srcSvg = svgsClone[i] as SVGElement
      const vb = srcSvg.getAttribute('viewBox') || ''
      const w = srcSvg.getAttribute('width')
      const h = srcSvg.getAttribute('height')
      if (w) img.setAttribute('width', w)
      if (h) img.setAttribute('height', h)
      if (!w && vb) {
        const parts = vb.split(/\s+/)
        if (parts.length === 4) img.setAttribute('width', parts[2])
        if (parts.length === 4) img.setAttribute('height', parts[3])
      }
      srcSvg.replaceWith(img)
    }
  } catch {}

  // 2) IMG src -> dataURL，设置宽高约束
  const imgs = Array.from(clone.querySelectorAll('img')) as HTMLImageElement[]
  for (const img of imgs) {
    try {
      const cur = img.getAttribute('src') || ''
      if (!/^data:/i.test(cur)) {
        const abs = img.getAttribute('data-abs-path') || ''
        const raw = img.getAttribute('data-raw-src') || cur
        let dataUrl = ''
        if (abs) dataUrl = await readLocalAsDataUrl(abs)
        if (!dataUrl && /^https?:/i.test(raw)) dataUrl = await fetchRemoteAsDataUrl(raw)
        if (!dataUrl && !/^data:/i.test(cur)) {
          try {
            const r = await fetch(cur, { mode: 'cors' })
            const blob = await r.blob()
            dataUrl = await new Promise<string>((resolve, reject) => {
              const fr = new FileReader()
              fr.onerror = () => reject(fr.error || new Error('读取失败'))
              fr.onload = () => resolve(String(fr.result || ''))
              fr.readAsDataURL(blob)
            })
          } catch {}
        }
        if (dataUrl) img.src = dataUrl
      }
      // 计算尺寸并约束到页宽内（约 700px）
      const maxPx = 700
      await new Promise<void>((resolve) => {
        try {
          const temp = new Image()
          temp.onload = () => {
            try {
              const w = temp.naturalWidth || temp.width || 1
              const h = temp.naturalHeight || temp.height || 1
              const ratio = w > 0 ? Math.min(1, maxPx / w) : 1
              const nw = Math.max(1, Math.round(w * ratio))
              const nh = Math.max(1, Math.round(h * ratio))
              img.setAttribute('width', String(nw))
              img.setAttribute('height', String(nh))
            } catch {}
            resolve()
          }
          temp.onerror = () => resolve()
          temp.src = img.getAttribute('src') || ''
        } catch { resolve() }
      })
    } catch (e) { console.warn('处理 IMG 失败', e) }
  }

  // 3) 注入基础样式（html-docx-js 对 style 支持有限，仍保留以兼容）
  const style = document.createElement('style')
  style.textContent = `
    .preview-body img, img { max-width: 100% !important; height: auto !important; }
    pre { white-space: pre-wrap; word-break: break-word; }
    code { word-break: break-word; }
  `
  clone.prepend(style)

  return clone.outerHTML
}

export async function exportDocx(htmlOrEl: string | HTMLElement, opt?: any): Promise<Uint8Array> {
  const htmlDocx = await ensureHtmlDocx()
  const html = typeof htmlOrEl === 'string' ? htmlOrEl : await preprocessElementForDocx(htmlOrEl)
  const blob: Blob = htmlDocx.asBlob(html, {
    orientation: 'portrait',
    margins: { top: 720, bottom: 720, left: 720, right: 720 },
    ...opt,
  })
  const ab = await blob.arrayBuffer()
  return new Uint8Array(ab)
}

