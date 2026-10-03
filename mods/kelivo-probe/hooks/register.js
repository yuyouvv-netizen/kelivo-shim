// Prompt-metadata audit and targeted tool-description compaction for
// Claude Code 2.1.287+ Mods. Prompt text is never recorded.
import { compactToolDescription } from '../tool-descriptions.js'

const PROBE_FILE = '/tmp/kelivo-claude-mod-probe.json'
const TOOL_AUDIT_FILE = '/tmp/kelivo-claude-mod-tools.json'
const AUDIT_ENABLED = process.env.CLAUDE_MOD_AUDIT_ENABLED !== '0'

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

const toolAudit = {
  schema: 2,
  capturedAt: null,
  updatedAt: null,
  count: 0,
  tools: [],
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
  if (!AUDIT_ENABLED) return
  state.updatedAt = now()
  await $.fs.write(PROBE_FILE, JSON.stringify(state, null, 2))
}

function toolName(event) {
  return typeof event?.tool === 'string' && event.tool ? event.tool : 'unknown'
}

function rememberTool(event, result, originalDescription) {
  const description = typeof result?.description === 'string'
    ? result.description
    : typeof event?.description === 'string' ? event.description : ''
  const original = typeof originalDescription === 'string'
    ? originalDescription
    : description
  const name = toolName(event)
  const entry = {
    name,
    description,
    chars: Array.from(description).length,
    originalChars: Array.from(original).length,
    savedChars: Math.max(0, Array.from(original).length - Array.from(description).length),
    compacted: description !== original,
    origin: typeof event?.origin?.kind === 'string' ? event.origin.kind : null,
  }
  const index = toolAudit.tools.findIndex((tool) => tool.name === name)
  if (index === -1) toolAudit.tools.push(entry)
  else toolAudit.tools[index] = entry
  toolAudit.tools.sort((left, right) => left.name.localeCompare(right.name))
  toolAudit.count = toolAudit.tools.length
  toolAudit.capturedAt ||= now()
  toolAudit.updatedAt = now()
}

async function flushToolAudit($) {
  if (!AUDIT_ENABLED) return
  await $.fs.write(TOOL_AUDIT_FILE, JSON.stringify(toolAudit, null, 2))
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

  on('tool.describe', async ($, e, next) => {
    const originalResult = await next(e)
    const originalDescription = typeof originalResult?.description === 'string'
      ? originalResult.description
      : undefined
    let result = originalResult
    try {
      const description = compactToolDescription(toolName(e), originalDescription)
      if (description !== originalDescription && originalResult && typeof originalResult === 'object') {
        result = { ...originalResult, description }
      }
    } catch (_) {
      // A compaction failure must leave the upstream description unchanged.
    }
    try {
      rememberTool(e, result, originalDescription)
      await flushToolAudit($)
    } catch (_) {
      // Auditing must never prevent a tool from being described to Claude.
    }
    return result
  })
}
