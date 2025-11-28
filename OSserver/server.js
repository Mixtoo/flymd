const http = require('http')
const url = require('url')
const crypto = require('crypto')
const WebSocket = require('ws')

const PORT = parseInt(process.env.COLLAB_OS_PORT || process.env.PORT || '3456', 10)
const PASSWORD_SALT = process.env.COLLAB_OS_PASSWORD_SALT || 'flymd-os-collab'

const MAX_WS_MESSAGE_BYTES = 256 * 1024
const MAX_WS_CONTENT_LENGTH = 1024 * 1024
const WS_UPDATE_WINDOW_MS = 10 * 1000
const MAX_WS_UPDATES_PER_WINDOW = 60

function hashPassword(password) {
  const p = String(password || '')
  return crypto.createHash('sha256').update(PASSWORD_SALT + ':' + p, 'utf8').digest('hex')
}

const rooms = new Map()
const clientLocks = new Map()

function broadcastToRoom(roomCode, payload) {
  const state = rooms.get(roomCode)
  if (!state) return
  const data = JSON.stringify(payload)
  for (const client of state.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(data)
      } catch {}
    }
  }
}

function broadcastPeers(roomCode) {
  const state = rooms.get(roomCode)
  if (!state) return
  const names = []
  try {
    for (const info of state.meta.values()) {
      const n = info && info.name ? String(info.name) : ''
      if (n && !names.includes(n)) names.push(n)
    }
  } catch {}
  broadcastToRoom(roomCode, { type: 'peers', peers: names })
}

function cleanupClient(roomCode, ws) {
  const state = rooms.get(roomCode)
  if (!state) return
  state.clients.delete(ws)
  state.meta.delete(ws)
  try {
    const cl = clientLocks.get(ws)
    if (cl) {
      clientLocks.delete(ws)
      if (cl.room === roomCode && cl.blocks && cl.blocks.size > 0) {
        const locksMap = state.locks
        if (locksMap && locksMap.size > 0) {
          let changed = false
          for (const blockId of cl.blocks) {
            const info = locksMap.get(blockId)
            if (info && info.ws === ws) {
              locksMap.delete(blockId)
              changed = true
            }
          }
          if (changed) {
            const locks = []
            for (const [id, v] of locksMap.entries()) {
              locks.push({ blockId: id, name: v.name, color: v.color, label: v.label || '' })
            }
            broadcastToRoom(roomCode, { type: 'locks_state', locks })
          }
        }
      }
    }
  } catch {}
  try {
    broadcastPeers(roomCode)
  } catch {}
}

async function handleWsConnection(ws, req, query) {
  const roomCode = String(query.room || '').trim()
  const password = String(query.password || '').trim()
  const name = String(query.name || '').trim() || '匿名'

  const xfwd = (req.headers && req.headers['x-forwarded-for']) || ''
  const ip =
    (typeof xfwd === 'string' && xfwd.split(',')[0].trim()) ||
    (req.socket && req.socket.remoteAddress) ||
    'unknown'

  if (!roomCode || !password) {
    try {
      ws.send(JSON.stringify({ type: 'error', code: 'bad_request', message: 'room 和 password 必填' }))
    } catch {}
    try {
      ws.close(4000, 'room/password required')
    } catch {}
    return
  }

  let state = rooms.get(roomCode)
  const pwdHash = hashPassword(password)
  if (!state) {
    state = {
      passwordHash: pwdHash,
      content: '',
      clients: new Set(),
      meta: new Map(),
      locks: new Map()
    }
    rooms.set(roomCode, state)
  } else {
    if (state.passwordHash !== pwdHash) {
      try {
        ws.send(JSON.stringify({ type: 'error', code: 'bad_password', message: '房间密码错误' }))
      } catch {}
      try {
        ws.close(4001, 'invalid password')
      } catch {}
      return
    }
  }

  const clientState = { room: roomCode, blocks: new Set() }
  clientLocks.set(ws, clientState)

  state.clients.add(ws)
  state.meta.set(ws, { name, ip })

  try {
    ws.send(JSON.stringify({ type: 'snapshot', content: state.content || '' }))
  } catch (e) {
    try {
      ws.close()
    } catch {}
    return
  }

  try {
    const locksMap = state.locks
    if (locksMap && locksMap.size > 0) {
      const locks = []
      for (const [blockId, info] of locksMap.entries()) {
        locks.push({ blockId, name: info.name, color: info.color, label: info.label || '' })
      }
      if (locks.length > 0) {
        ws.send(JSON.stringify({ type: 'locks_state', locks }))
      }
    }
  } catch {}

  try {
    broadcastPeers(roomCode)
  } catch {}

  let updateWindowStart = Date.now()
  let updateCountInWindow = 0

  ws.on('message', (data) => {
    try {
      const size =
        typeof data === 'string'
          ? Buffer.byteLength(data, 'utf8')
          : data && typeof data.length === 'number'
          ? data.length
          : 0
      if (size > MAX_WS_MESSAGE_BYTES) {
        try {
          ws.send(
            JSON.stringify({
              type: 'error',
              code: 'message_too_large',
              message: '协同消息过大，连接已关闭'
            })
          )
        } catch {}
        try {
          ws.close()
        } catch {}
        return
      }
    } catch {}

    let msg
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return

    if (msg.type === 'join') {
      if (!state.content && typeof msg.content === 'string') {
        state.content = msg.content
        broadcastToRoom(roomCode, {
          type: 'update',
          content: state.content
        })
      }
      return
    }

    if (msg.type === 'lock') {
      const blockId = typeof msg.blockId === 'string' ? msg.blockId.trim() : ''
      if (!blockId) return
      const color = typeof msg.color === 'string' ? msg.color : ''
      const label = typeof msg.label === 'string' ? msg.label : ''
      let locksMap = state.locks
      if (!locksMap) {
        locksMap = new Map()
        state.locks = locksMap
      }
      try {
        const cl = clientLocks.get(ws)
        if (cl && cl.blocks && cl.blocks.size > 0) {
          for (const id of Array.from(cl.blocks)) {
            if (id === blockId) continue
            const info = locksMap.get(id)
            if (info && info.ws === ws) {
              locksMap.delete(id)
              cl.blocks.delete(id)
            }
          }
        }
      } catch {}
      const existing = locksMap.get(blockId)
      if (existing && existing.ws && existing.ws !== ws) {
        try {
          ws.send(
            JSON.stringify({
              type: 'lock_error',
              code: 'locked_by_other',
              blockId,
              name: existing.name || '他人'
            })
          )
        } catch {}
        return
      }
      locksMap.set(blockId, { name, color, label, ws })
      const cl = clientLocks.get(ws)
      if (cl && cl.blocks) {
        cl.blocks.add(blockId)
      }
      const locks = []
      for (const [id, info] of locksMap.entries()) {
        locks.push({ blockId: id, name: info.name, color: info.color, label: info.label || '' })
      }
      broadcastToRoom(roomCode, { type: 'locks_state', locks })
      return
    }

    if (msg.type === 'unlock') {
      const blockId = typeof msg.blockId === 'string' ? msg.blockId.trim() : ''
      if (!blockId) return
      const locksMap = state.locks
      if (!locksMap) return
      const info = locksMap.get(blockId)
      if (!info || (info.ws && info.ws !== ws)) return
      locksMap.delete(blockId)
      const cl = clientLocks.get(ws)
      if (cl && cl.blocks) cl.blocks.delete(blockId)
      const locks = []
      for (const [id, v] of locksMap.entries()) {
        locks.push({ blockId: id, name: v.name, color: v.color, label: v.label || '' })
      }
      broadcastToRoom(roomCode, { type: 'locks_state', locks })
      return
    }

    if (msg.type === 'update') {
      if (typeof msg.content !== 'string') return

      try {
        const now = Date.now()
        if (now - updateWindowStart > WS_UPDATE_WINDOW_MS) {
          updateWindowStart = now
          updateCountInWindow = 0
        }
        updateCountInWindow++
        if (updateCountInWindow > MAX_WS_UPDATES_PER_WINDOW) {
          try {
            ws.send(
              JSON.stringify({
                type: 'error',
                code: 'too_many_updates',
                message: '协同更新过于频繁，连接已关闭'
              })
            )
          } catch {}
          try {
            ws.close()
          } catch {}
          return
        }
      } catch {}

      try {
        if (typeof msg.content === 'string' && msg.content.length > MAX_WS_CONTENT_LENGTH) {
          try {
            ws.send(
              JSON.stringify({
                type: 'error',
                code: 'content_too_large',
                message: '协同内容过长，已被服务器拒绝'
              })
            )
          } catch {}
          return
        }
      } catch {}

      state.content = msg.content
      broadcastToRoom(roomCode, {
        type: 'update',
        content: state.content
      })
      return
    }

    if (msg.type === 'ping') {
      try {
        ws.send(JSON.stringify({ type: 'pong' }))
      } catch {}
      return
    }
  })

  ws.on('close', () => {
    cleanupClient(roomCode, ws)
  })

  ws.on('error', () => {
    cleanupClient(roomCode, ws)
  })
}

function handleHttp(req, res) {
  const parsed = url.parse(req.url || '')
  const pathname = parsed.pathname || '/'
  if (pathname === '/health') {
    const body = Buffer.from(JSON.stringify({ ok: true }), 'utf8')
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Length', String(body.length))
    res.end(body)
    return
  }
  res.statusCode = 404
  res.end('Not Found')
}

function main() {
  const server = http.createServer(handleHttp)
  const wss = new WebSocket.Server({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const parsed = url.parse(req.url || '', true)
    if (parsed.pathname !== '/ws') {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, parsed.query || {})
    })
  })

  wss.on('connection', (ws, req, query) => {
    handleWsConnection(ws, req, query).catch((err) => {
      try {
        console.error('[os-collab] WS connection error:', err)
      } catch {}
      try {
        if (ws.readyState === WebSocket.OPEN) ws.close()
      } catch {}
    })
  })

  server.listen(PORT)
}

if (require.main === module) {
  main()
}

