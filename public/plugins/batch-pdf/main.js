// 批量导出 PDF 插件
export function activate(context) {
  const ok = !!context.pickDocFiles && !!context.openFileByPath && !!context.exportCurrentToPdf
  if (!ok) {
    context.ui.notice('当前版本不支持批量导出接口', 'err', 2600)
    return
  }

  context.addMenuItem({
    label: '批量导出PDF',
    title: '一次选择多个文档并生成 PDF',
    onClick: async () => {
      try {
        const files = await context.pickDocFiles({ multiple: true })
        if (!files || !files.length) {
          context.ui.notice('未选择任何文档', 'err', 2000)
          return
        }

        const okConfirm = await context.ui.confirm(
          '将对 ' + files.length + ' 个文档生成同名 PDF，保存在原目录，是否继续？'
        )
        if (!okConfirm) return

        let okCount = 0
        let failCount = 0

        for (const raw of files) {
          const src = String(raw || '').trim()
          if (!src) continue

          const ext = (src.split('.').pop() || '').toLowerCase()
          if (ext !== 'md' && ext !== 'markdown' && ext !== 'txt') {
            failCount++
            continue
          }

          const target = src.replace(/\.[^.]+$/, '') + '.pdf'
          try {
            await context.openFileByPath(src)
            await context.exportCurrentToPdf(target)
            okCount++
          } catch {
            failCount++
          }
        }

        const msg = failCount
          ? '批量导出完成：成功 ' + okCount + ' 个，失败 ' + failCount + ' 个'
          : '批量导出完成：成功 ' + okCount + ' 个'
        context.ui.notice(msg, failCount ? 'err' : 'ok', 4000)
      } catch (e) {
        const msg = e && e.message ? String(e.message) : String(e || '未知错误')
        context.ui.notice('批量导出失败：' + msg, 'err', 4000)
      }
    }
  })
}

export function deactivate() { /* 无需清理 */ }

