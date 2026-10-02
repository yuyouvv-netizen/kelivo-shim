// Metadata-only probe for Claude Code 2.1.287+ Mods.
// It never records prompt text and never changes an event or its result.
const PROBE_FILE = '/tmp/kelivo-claude-mod-probe.json'

const state = {
  schema: 1,
  loaded: false,
  loadedAt: null,
  updatedAt: null,
  sections: [],
  attachments: {},
  compose: [],
  usage: null,
}

function now() {
  return new Date().toISOString()
}

function finite(value) {
  return Number.isFinite(value) ? value : null
}

function rememberSection(name) {
  if (typeof name !== 'string' || !name || state.sections.includes(name)) return
  state.sections.push(name)
  state.sections.sort()
}

function rememberAttachment(type, origin) {
  const key = typeof type === 'string' && type ? type : 'unknown'
  const previous = state.attachments[key] || { count: 0, origins: [] }
  previous.count += 1
  if (typeof origin === 'string' && origin && !previous.origins.includes(origin)) {
    previous.origins.push(origin)
    previous.origins.sort()
  }
  state.attachments[key] = previous
}

async function flush($) {
  state.updatedAt = now()
  await $.fs.write(PROBE_FILE, JSON.stringify(state, null, 2))
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    state.loaded = true
    state.loadedAt = now()
    await flush($)
    return next(e)
  })

  on('prompt.section', async ($, e, next) => {
    const result = await next(e)
    rememberSection(e.name)
    await flush($)
    return result
  })

  on('prompt.attachment', async ($, e, next) => {
    rememberAttachment(e.type, e.origin && e.origin.kind)
    await flush($)
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (result && Array.isArray(result.sections)) {
      state.compose = result.sections.map((section) => ({
        id: typeof section.id === 'string' ? section.id : null,
        scope: typeof section.scope === 'string' ? section.scope : null,
      }))
      await flush($)
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    try {
      const usage = await $.session.usage()
      const context = usage && usage.context
      state.usage = context ? {
        tokens: finite(context.tokens),
        window: finite(context.window),
        percent: finite(context.percent),
      } : null
      await flush($)
    } catch (_) {
      // The probe must never affect a conversation when usage is unavailable.
    }
    return result
  })
}
