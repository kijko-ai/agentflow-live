import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { AgentEvent, SessionInfo, SessionProvider, emitSubagentSpawn } from './protocol'
import {
  ACTIVE_SESSION_AGE_S, ARGS_MAX, CHILD_NAME_MAX, INACTIVITY_TIMEOUT_MS,
  MESSAGE_MAX, ORCHESTRATOR_NAME, POLL_FALLBACK_MS, SCAN_INTERVAL_MS,
  SESSION_ID_DISPLAY, SESSION_LABEL_MAX, SESSION_LABEL_TRUNCATED,
} from './constants'
import { readFileChunk, readNewFileLines } from './fs-utils'
import { createLogger } from './logger'
import { detectError, summarizeResult } from './tool-summarizer'
import { estimateTokensFromContent, estimateTokensFromText } from './token-estimator'

const log = createLogger('CodexSessionWatcher')

const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions')
const CODEX_SESSION_INDEX = path.join(os.homedir(), '.codex', 'session_index.jsonl')
const META_READ_MAX = 256 * 1024
const CHILD_SUMMARY_MAX = 160
const TOOL_OUTPUT_JSON_MAX = 2_000

interface ContextBreakdown {
  systemPrompt: number
  userMessages: number
  toolResults: number
  reasoning: number
  subagentResults: number
}

interface CodexSessionMeta {
  threadId: string
  filePath: string
  cwd: string | null
  forkedFromId: string | null
  parentThreadId: string | null
  agentNickname: string | null
  agentPath: string | null
  agentRole: string | null
  modelProvider: string | null
}

interface PendingToolCall {
  callId: string
  name: string
  argsSummary: string
  inputData?: Record<string, unknown>
  startTime: number
  rawArgs?: Record<string, unknown>
}

interface RootSessionState {
  sessionId: string
  label: string
  labelSet: boolean
  sessionStartTime: number
  lastActivityTime: number
  sessionCompleted: boolean
  inactivityTimer: NodeJS.Timeout | null
  emittedAgents: Set<string>
  taskNamesToAgents: Map<string, string>
}

interface ThreadState {
  threadId: string
  rootSessionId: string
  parentThreadId: string | null
  filePath: string
  fileWatcher: fs.FSWatcher | null
  pollTimer: NodeJS.Timeout | null
  inactivityTimer: NodeJS.Timeout | null
  fileSize: number
  agentName: string
  provider: SessionProvider
  isRoot: boolean
  pendingToolCalls: Map<string, PendingToolCall>
  seenMessages: Set<string>
  contextBreakdown: ContextBreakdown
  model: string | null
  completed: boolean
  catchUpMessages: Array<{ role: 'user' | 'assistant'; content: string }>
}

function emptyBreakdown(): ContextBreakdown {
  return { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 }
}

function safeParseJson<T>(input: string | undefined | null): T | null {
  if (!input) return null
  try {
    return JSON.parse(input) as T
  } catch {
    return null
  }
}

function sanitizeText(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ')
}

function containsWorkspace(candidate: string | null, workspace: string | null): boolean {
  if (!candidate || !workspace) return true
  return candidate === workspace || candidate.startsWith(workspace + path.sep)
}

function truncateLabel(label: string): string {
  return label.length <= SESSION_LABEL_MAX ? label : label.slice(0, SESSION_LABEL_TRUNCATED) + '...'
}

function readFileHead(filePath: string, maxBytes = META_READ_MAX): string {
  let stat: fs.Stats
  try { stat = fs.statSync(filePath) } catch { return '' }
  const bytes = Math.min(stat.size, maxBytes)
  if (bytes <= 0) return ''
  return readFileChunk(filePath, 0, bytes)
}

function parseSessionMeta(filePath: string): CodexSessionMeta | null {
  const head = readFileHead(filePath)
  if (!head) return null

  const firstLine = head.split(/\r?\n/, 1)[0]
  const parsed = safeParseJson<{ payload?: Record<string, unknown> }>(firstLine)
  const payload = parsed?.payload

  if (payload && typeof payload.id === 'string') {
    const source = payload.source as Record<string, unknown> | string | undefined
    const subagent = typeof source === 'object' && source
      ? (source.subagent as Record<string, unknown> | undefined)
      : undefined
    const spawn = subagent?.thread_spawn as Record<string, unknown> | undefined
    return {
      threadId: payload.id,
      filePath,
      cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
      forkedFromId: typeof payload.forked_from_id === 'string' ? payload.forked_from_id : null,
      parentThreadId: typeof spawn?.parent_thread_id === 'string' ? spawn.parent_thread_id : null,
      agentNickname: typeof payload.agent_nickname === 'string' ? payload.agent_nickname : null,
      agentPath: typeof payload.agent_path === 'string' ? payload.agent_path : null,
      agentRole: typeof payload.agent_role === 'string' ? payload.agent_role : null,
      modelProvider: typeof payload.model_provider === 'string' ? payload.model_provider : null,
    }
  }

  const getMatch = (pattern: RegExp) => pattern.exec(head)?.[1] ?? null
  const threadId = getMatch(/"id":"([^"]+)"/)
  if (!threadId) return null
  return {
    threadId,
    filePath,
    cwd: getMatch(/"cwd":"([^"]+)"/),
    forkedFromId: getMatch(/"forked_from_id":"([^"]+)"/),
    parentThreadId: getMatch(/"parent_thread_id":"([^"]+)"/),
    agentNickname: getMatch(/"agent_nickname":"([^"]+)"/),
    agentPath: getMatch(/"agent_path":"([^"]+)"/),
    agentRole: getMatch(/"agent_role":"([^"]+)"/),
    modelProvider: getMatch(/"model_provider":"([^"]+)"/),
  }
}

function walkJsonlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(fullPath)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(fullPath)
    }
  }
  return out
}

function summarizeToolInput(name: string, input: Record<string, unknown> | null): string {
  if (!input) return name
  if (name === 'exec_command') return sanitizeText(input.cmd).slice(0, ARGS_MAX)
  if (name === 'spawn_agent') {
    const label = sanitizeText(input.task_name || input.message || input.agent_type || 'spawn subagent')
    return label.slice(0, ARGS_MAX)
  }
  if (name === 'wait_agent') {
    const targets = Array.isArray(input.targets) ? input.targets : Array.isArray(input.ids) ? input.ids : []
    return `${targets.length || 1} target${targets.length === 1 ? '' : 's'}`.slice(0, ARGS_MAX)
  }
  if (name === 'send_input') return sanitizeText(input.message || input.target || 'send input').slice(0, ARGS_MAX)
  if (name === 'update_plan') {
    const plan = Array.isArray(input.plan) ? input.plan : []
    const active = plan.find((item) => item && typeof item === 'object' && (item as Record<string, unknown>).status === 'in_progress') as Record<string, unknown> | undefined
    return sanitizeText(active?.step || input.explanation || `update plan (${plan.length})`).slice(0, ARGS_MAX)
  }
  if (name === 'apply_patch') return 'apply patch'
  if (name === 'web_search_call') return sanitizeText(input.query || input.url || input.pattern || 'web search').slice(0, ARGS_MAX)
  return JSON.stringify(input).slice(0, ARGS_MAX)
}

function extractInputData(name: string, input: Record<string, unknown> | null): Record<string, unknown> | undefined {
  if (!input) return undefined
  if (name === 'exec_command') {
    return {
      command: String(input.cmd || ''),
      workdir: typeof input.workdir === 'string' ? input.workdir : undefined,
    }
  }
  if (name === 'spawn_agent') {
    return {
      task_name: typeof input.task_name === 'string' ? input.task_name : undefined,
      message: typeof input.message === 'string' ? input.message.slice(0, 500) : undefined,
      agent_type: typeof input.agent_type === 'string' ? input.agent_type : undefined,
    }
  }
  if (name === 'apply_patch') {
    return {
      patch: JSON.stringify(input).slice(0, 500),
    }
  }
  return undefined
}

function summarizeToolOutput(name: string, output: unknown): string {
  if (typeof output === 'string') {
    const parsed = safeParseJson<Record<string, unknown>>(output)
    if (parsed && typeof parsed.output === 'string') return summarizeResult(parsed.output)
    if (parsed && typeof parsed.nickname === 'string') return `spawned ${parsed.nickname}`
    if (parsed && parsed.timed_out === true) return 'timed out'
  }
  if (name === 'web_search_call' && output && typeof output === 'object') {
    const action = output as Record<string, unknown>
    return sanitizeText(action.type || action.url || action.query || 'web search').slice(0, TOOL_OUTPUT_JSON_MAX)
  }
  return summarizeResult(output).slice(0, TOOL_OUTPUT_JSON_MAX)
}

function normalizeTokenBreakdown(totalUsage: Record<string, unknown> | undefined): ContextBreakdown | null {
  if (!totalUsage) return null
  const inputTokens = typeof totalUsage.input_tokens === 'number' ? totalUsage.input_tokens : 0
  const cachedInputTokens = typeof totalUsage.cached_input_tokens === 'number' ? totalUsage.cached_input_tokens : 0
  const outputTokens = typeof totalUsage.output_tokens === 'number' ? totalUsage.output_tokens : 0
  const reasoningTokens = typeof totalUsage.reasoning_output_tokens === 'number' ? totalUsage.reasoning_output_tokens : 0
  return {
    systemPrompt: cachedInputTokens,
    userMessages: Math.max(0, inputTokens),
    toolResults: 0,
    reasoning: outputTokens + reasoningTokens,
    subagentResults: 0,
  }
}

function totalsForBreakdown(bd: ContextBreakdown): number {
  return bd.systemPrompt + bd.userMessages + bd.toolResults + bd.reasoning + bd.subagentResults
}

export class CodexSessionWatcher implements vscode.Disposable {
  private scanInterval: NodeJS.Timeout | null = null
  private workspacePath: string | null = null
  private resolvedWorkspace: string | null = null
  private sessionLabels = new Map<string, string>()
  private sessionIndexMtime = 0
  private metaCache = new Map<string, { mtimeMs: number; meta: CodexSessionMeta | null }>()
  private threadStates = new Map<string, ThreadState>()
  private rootSessions = new Map<string, RootSessionState>()

  private readonly _onEvent = new vscode.EventEmitter<AgentEvent>()
  private readonly _onSessionDetected = new vscode.EventEmitter<string>()
  private readonly _onSessionLifecycle = new vscode.EventEmitter<{ type: 'started' | 'ended' | 'updated'; sessionId: string; label: string }>()

  readonly onEvent = this._onEvent.event
  readonly onSessionDetected = this._onSessionDetected.event
  readonly onSessionLifecycle = this._onSessionLifecycle.event

  isActive(): boolean {
    return Array.from(this.rootSessions.values()).some((session) => !session.sessionCompleted)
  }

  isSessionActive(sessionId: string): boolean {
    const session = this.rootSessions.get(sessionId)
    return !!session && !session.sessionCompleted
  }

  getActiveSessions(): SessionInfo[] {
    return Array.from(this.rootSessions.values()).map((session) => ({
      id: session.sessionId,
      label: session.label,
      provider: 'codex',
      status: session.sessionCompleted ? 'completed' : 'active',
      startTime: session.sessionStartTime,
      lastActivityTime: session.lastActivityTime,
    }))
  }

  replaySessionStart(sessionIds?: string[]): void {
    for (const [sessionId, session] of this.rootSessions) {
      if (sessionIds && !sessionIds.includes(sessionId)) continue
      this.emit({
        time: 0,
        type: 'agent_spawn',
        payload: {
          name: ORCHESTRATOR_NAME,
          isMain: true,
          task: session.label,
          provider: 'codex',
        },
      }, sessionId)
      this._onSessionDetected.fire(sessionId)
    }
  }

  start(): void {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (workspaceFolder) {
      this.workspacePath = workspaceFolder
      try { this.resolvedWorkspace = fs.realpathSync(workspaceFolder) } catch { this.resolvedWorkspace = workspaceFolder }
    }
    this.refreshSessionIndex()
    this.scanForActiveSessions()
    this.scanInterval = setInterval(() => {
      this.refreshSessionIndex()
      this.scanForActiveSessions()
    }, SCAN_INTERVAL_MS)
  }

  private refreshSessionIndex(): void {
    let stat: fs.Stats
    try { stat = fs.statSync(CODEX_SESSION_INDEX) } catch { return }
    if (stat.mtimeMs === this.sessionIndexMtime) return
    this.sessionIndexMtime = stat.mtimeMs
    const next = new Map<string, string>()
    try {
      const content = fs.readFileSync(CODEX_SESSION_INDEX, 'utf8')
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue
        const parsed = safeParseJson<{ id?: string; thread_name?: string }>(line)
        if (parsed?.id && parsed.thread_name) next.set(parsed.id, parsed.thread_name)
      }
    } catch (err) {
      log.debug('Failed to refresh session_index.jsonl:', err)
      return
    }
    this.sessionLabels = next
  }

  private scanForActiveSessions(): void {
    if (!fs.existsSync(CODEX_SESSIONS_DIR)) return

    const files = walkJsonlFiles(CODEX_SESSIONS_DIR)
    const metasByThread = new Map<string, CodexSessionMeta>()
    const activeMetas: CodexSessionMeta[] = []

    for (const filePath of files) {
      let stat: fs.Stats
      try { stat = fs.statSync(filePath) } catch { continue }
      const meta = this.getMetaForFile(filePath, stat.mtimeMs)
      if (!meta) continue
      if (!containsWorkspace(meta.cwd, this.resolvedWorkspace)) continue
      metasByThread.set(meta.threadId, meta)
      const ageSeconds = (Date.now() - stat.mtimeMs) / 1000
      if (ageSeconds <= ACTIVE_SESSION_AGE_S) {
        activeMetas.push(meta)
      }
    }

    const activeRoots = new Map<string, CodexSessionMeta[]>()
    for (const meta of activeMetas) {
      const rootSessionId = this.resolveRootSessionId(meta.threadId, metasByThread)
      const group = activeRoots.get(rootSessionId) || []
      group.push(meta)
      activeRoots.set(rootSessionId, group)
    }

    for (const [rootSessionId, metas] of activeRoots) {
      const rootMeta = metasByThread.get(rootSessionId) || metas.find((meta) => meta.threadId === rootSessionId) || metas[0]
      if (rootMeta && !this.threadStates.has(rootSessionId)) {
        this.watchThread(rootMeta, rootSessionId)
      }
      for (const meta of metas) {
        if (!this.threadStates.has(meta.threadId)) {
          this.watchThread(meta, rootSessionId)
        }
      }
    }
  }

  private getMetaForFile(filePath: string, mtimeMs: number): CodexSessionMeta | null {
    const cached = this.metaCache.get(filePath)
    if (cached && cached.mtimeMs === mtimeMs) return cached.meta
    const meta = parseSessionMeta(filePath)
    this.metaCache.set(filePath, { mtimeMs, meta })
    return meta
  }

  private resolveRootSessionId(threadId: string, metasByThread: Map<string, CodexSessionMeta>): string {
    let current = metasByThread.get(threadId)
    const seen = new Set<string>()
    while (current?.parentThreadId && !seen.has(current.parentThreadId)) {
      seen.add(current.threadId)
      const parent = metasByThread.get(current.parentThreadId)
      if (!parent) return current.parentThreadId
      current = parent
    }
    return current?.threadId || threadId
  }

  private watchThread(meta: CodexSessionMeta, rootSessionId: string): void {
    const isRoot = meta.threadId === rootSessionId
    const thread: ThreadState = {
      threadId: meta.threadId,
      rootSessionId,
      parentThreadId: meta.parentThreadId,
      filePath: meta.filePath,
      fileWatcher: null,
      pollTimer: null,
      inactivityTimer: null,
      fileSize: 0,
      agentName: isRoot ? ORCHESTRATOR_NAME : this.resolveChildAgentName(meta),
      provider: 'codex',
      isRoot,
      pendingToolCalls: new Map(),
      seenMessages: new Set(),
      contextBreakdown: emptyBreakdown(),
      model: null,
      completed: false,
      catchUpMessages: [],
    }

    let stat: fs.Stats
    try { stat = fs.statSync(meta.filePath) } catch { return }
    if (stat.size > 0) {
      const content = readFileChunk(meta.filePath, 0, stat.size)
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue
        this.processLine(thread, line, false)
      }
      thread.fileSize = stat.size
    }

    this.threadStates.set(thread.threadId, thread)

    const root = this.ensureRootSession(rootSessionId)
    root.lastActivityTime = Date.now()
    if (thread.isRoot && !root.labelSet) {
      const label = this.sessionLabels.get(rootSessionId)
      if (label) {
        root.label = truncateLabel(label)
        root.labelSet = true
        this._onSessionLifecycle.fire({ type: 'updated', sessionId: root.sessionId, label: root.label })
      }
    }

    if (!thread.isRoot) {
      this.emitChildSpawn(thread, root)
    }
    if (thread.model) {
      this.emit({
        time: this.elapsed(rootSessionId),
        type: 'model_detected',
        payload: { agent: thread.agentName, model: thread.model },
      }, rootSessionId)
    }
    if (thread.catchUpMessages.length > 0) {
      for (const message of thread.catchUpMessages) {
        this.emit({
          time: 0,
          type: 'message',
          payload: { agent: thread.agentName, role: message.role, content: message.content.slice(0, MESSAGE_MAX) },
        }, rootSessionId)
      }
    }

    try {
      thread.fileWatcher = fs.watch(meta.filePath, (eventType) => {
        if (eventType === 'change') this.readNewLines(thread.threadId)
      })
    } catch (err) {
      log.debug(`fs.watch failed for ${meta.filePath}:`, err)
    }
    thread.pollTimer = setInterval(() => this.readNewLines(thread.threadId), POLL_FALLBACK_MS)
    this.resetInactivity(thread.threadId)
  }

  private ensureRootSession(rootSessionId: string): RootSessionState {
    const existing = this.rootSessions.get(rootSessionId)
    if (existing) return existing

    const defaultLabel = this.sessionLabels.get(rootSessionId) || `Codex ${rootSessionId.slice(0, SESSION_ID_DISPLAY)}`
    const session: RootSessionState = {
      sessionId: rootSessionId,
      label: truncateLabel(defaultLabel),
      labelSet: this.sessionLabels.has(rootSessionId),
      sessionStartTime: Date.now(),
      lastActivityTime: Date.now(),
      sessionCompleted: false,
      inactivityTimer: null,
      emittedAgents: new Set([ORCHESTRATOR_NAME]),
      taskNamesToAgents: new Map(),
    }
    this.rootSessions.set(rootSessionId, session)

    this._onSessionDetected.fire(rootSessionId)
    this._onSessionLifecycle.fire({ type: 'started', sessionId: rootSessionId, label: session.label })
    this.emit({
      time: 0,
      type: 'agent_spawn',
      payload: {
        name: ORCHESTRATOR_NAME,
        isMain: true,
        task: session.label,
        provider: 'codex',
      },
    }, rootSessionId)
    return session
  }

  private resolveChildAgentName(meta: CodexSessionMeta): string {
    const label = sanitizeText(meta.agentNickname || meta.agentRole || meta.agentPath || meta.threadId)
    return label.slice(0, CHILD_NAME_MAX) || `subagent-${meta.threadId.slice(-6)}`
  }

  private emitChildSpawn(thread: ThreadState, root: RootSessionState, task = ''): void {
    if (root.emittedAgents.has(thread.agentName)) return
    root.emittedAgents.add(thread.agentName)
    const parentName = thread.parentThreadId
      ? (this.threadStates.get(thread.parentThreadId)?.agentName || ORCHESTRATOR_NAME)
      : ORCHESTRATOR_NAME
    emitSubagentSpawn({
      emit: (event, sessionId) => this.emit(event, sessionId),
      elapsed: (sessionId) => this.elapsed(sessionId || root.sessionId),
    }, parentName, thread.agentName, task || thread.agentName, root.sessionId)
  }

  private readNewLines(threadId: string): void {
    const thread = this.threadStates.get(threadId)
    if (!thread) return
    const result = readNewFileLines(thread.filePath, thread.fileSize)
    if (!result) return
    thread.fileSize = result.newSize
    if (result.lines.length === 0) return
    for (const line of result.lines) {
      this.processLine(thread, line, true)
    }
    this.resetInactivity(threadId)
  }

  private processLine(thread: ThreadState, line: string, emitEvents: boolean): void {
    const parsed = safeParseJson<{ type?: string; payload?: Record<string, unknown> }>(line.trim())
    if (!parsed?.type) return
    const payload = parsed.payload || {}
    const root = this.ensureRootSession(thread.rootSessionId)

    if (parsed.type === 'turn_context') {
      const model = typeof payload.model === 'string' ? payload.model : null
      if (model && thread.model !== model) {
        thread.model = model
        if (emitEvents) {
          this.emit({
            time: this.elapsed(thread.rootSessionId),
            type: 'model_detected',
            payload: { agent: thread.agentName, model },
          }, thread.rootSessionId)
        }
      }
      return
    }

    if (parsed.type === 'event_msg') {
      this.handleEventMessage(thread, root, payload, emitEvents)
      return
    }

    if (parsed.type === 'response_item') {
      this.handleResponseItem(thread, root, payload, emitEvents)
    }
  }

  private handleEventMessage(thread: ThreadState, root: RootSessionState, payload: Record<string, unknown>, emitEvents: boolean): void {
    const type = typeof payload.type === 'string' ? payload.type : ''
    if (type === 'user_message') {
      const text = sanitizeText(payload.message)
      if (!text) return
      const hash = `user:${text.slice(0, 160)}`
      if (thread.seenMessages.has(hash)) return
      thread.seenMessages.add(hash)
      thread.catchUpMessages = [{ role: 'user', content: text }]
      thread.contextBreakdown.userMessages += estimateTokensFromText(text)
      if (thread.isRoot && !root.labelSet) {
        root.label = truncateLabel(text)
        root.labelSet = true
      }
      if (emitEvents) {
        this.emit({
          time: this.elapsed(thread.rootSessionId),
          type: 'message',
          payload: { agent: thread.agentName, role: 'user', content: text.slice(0, MESSAGE_MAX) },
        }, thread.rootSessionId)
        this.emitContextUpdate(thread)
        if (thread.isRoot) {
          this._onSessionLifecycle.fire({ type: 'updated', sessionId: root.sessionId, label: root.label })
        }
      }
      return
    }

    if (type === 'agent_message') {
      const text = sanitizeText(payload.message)
      if (!text) return
      const hash = `assistant:${text.slice(0, 160)}`
      if (thread.seenMessages.has(hash)) return
      thread.seenMessages.add(hash)
      thread.catchUpMessages.push({ role: 'assistant', content: text })
      thread.contextBreakdown.reasoning += estimateTokensFromText(text)
      if (emitEvents) {
        this.emit({
          time: this.elapsed(thread.rootSessionId),
          type: 'message',
          payload: { agent: thread.agentName, role: 'assistant', content: text.slice(0, MESSAGE_MAX) },
        }, thread.rootSessionId)
        this.emitContextUpdate(thread)
      }
      return
    }

    if (type === 'token_count') {
      const info = payload.info as Record<string, unknown> | null
      const totalUsage = info?.total_token_usage as Record<string, unknown> | undefined
      const breakdown = normalizeTokenBreakdown(totalUsage)
      if (breakdown) {
        thread.contextBreakdown = breakdown
        if (emitEvents) this.emitContextUpdate(thread)
      }
      return
    }

    if (type === 'task_complete') {
      const text = sanitizeText(payload.last_agent_message)
      if (text) {
        const hash = `assistant:${text.slice(0, 160)}`
        if (!thread.seenMessages.has(hash)) {
          thread.seenMessages.add(hash)
          if (emitEvents) {
            this.emit({
              time: this.elapsed(thread.rootSessionId),
              type: 'message',
              payload: { agent: thread.agentName, role: 'assistant', content: text.slice(0, MESSAGE_MAX) },
            }, thread.rootSessionId)
          }
        }
      }
      if (emitEvents) this.completeThread(thread, text || 'Completed')
      return
    }

    if (type === 'turn_aborted') {
      if (emitEvents) this.completeThread(thread, 'Aborted')
    }
  }

  private handleResponseItem(thread: ThreadState, root: RootSessionState, payload: Record<string, unknown>, emitEvents: boolean): void {
    const type = typeof payload.type === 'string' ? payload.type : ''
    if (type === 'message' || type === 'reasoning') return

    if (type === 'function_call') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : null
      const name = typeof payload.name === 'string' ? payload.name : 'tool'
      const rawArgs = safeParseJson<Record<string, unknown>>(typeof payload.arguments === 'string' ? payload.arguments : '')
      const argsSummary = summarizeToolInput(name, rawArgs)
      if (!callId || thread.pendingToolCalls.has(callId)) return
      thread.pendingToolCalls.set(callId, {
        callId,
        name,
        argsSummary,
        inputData: extractInputData(name, rawArgs),
        startTime: Date.now(),
        rawArgs: rawArgs || undefined,
      })
      if (emitEvents) {
        this.emit({
          time: this.elapsed(thread.rootSessionId),
          type: 'tool_call_start',
          payload: {
            agent: thread.agentName,
            tool: name,
            args: argsSummary,
            preview: `${name}: ${argsSummary}`.slice(0, 120),
            inputData: extractInputData(name, rawArgs),
          },
        }, thread.rootSessionId)
      }
      return
    }

    if (type === 'function_call_output') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : null
      if (!callId) return
      const pending = thread.pendingToolCalls.get(callId)
      const output = payload.output
      if (!pending) return
      thread.pendingToolCalls.delete(callId)

      if (pending.name === 'spawn_agent') {
        const parsedOutput = safeParseJson<Record<string, unknown>>(typeof output === 'string' ? output : '')
        const childName = sanitizeText(parsedOutput?.nickname || parsedOutput?.task_name || pending.rawArgs?.task_name || pending.argsSummary).slice(0, CHILD_NAME_MAX)
        if (childName) {
          root.taskNamesToAgents.set(String(parsedOutput?.task_name || pending.rawArgs?.task_name || childName), childName)
          const childThread: ThreadState = {
            ...thread,
            threadId: String(parsedOutput?.agent_id || childName),
            agentName: childName,
            isRoot: false,
            parentThreadId: thread.threadId,
            pendingToolCalls: new Map(),
            seenMessages: new Set(),
            contextBreakdown: emptyBreakdown(),
            catchUpMessages: [],
            fileWatcher: null,
            pollTimer: null,
            inactivityTimer: null,
            fileSize: 0,
            completed: false,
            model: null,
          }
          if (emitEvents) this.emitChildSpawn(childThread, root, pending.argsSummary)
        }
      }

      if (pending.name === 'wait_agent' && typeof output === 'string') {
        const parsedOutput = safeParseJson<Record<string, unknown>>(output)
        if (parsedOutput?.timed_out === false) {
          const rawTargets = Array.isArray(pending.rawArgs?.targets)
            ? pending.rawArgs?.targets
            : Array.isArray(pending.rawArgs?.ids)
              ? pending.rawArgs?.ids
              : []
          for (const target of rawTargets) {
            const childName = this.resolveWaitTarget(target, root)
            if (!childName) continue
            this.emit({
              time: this.elapsed(thread.rootSessionId),
              type: 'subagent_return',
              payload: { child: childName, parent: thread.agentName, summary: 'Completed' },
            }, thread.rootSessionId)
            this.emit({
              time: this.elapsed(thread.rootSessionId),
              type: 'agent_complete',
              payload: { name: childName },
            }, thread.rootSessionId)
          }
        }
      }

      if (emitEvents) {
        const result = summarizeToolOutput(pending.name, output)
        const isError = detectError(result)
        this.emit({
          time: this.elapsed(thread.rootSessionId),
          type: 'tool_call_end',
          payload: {
            agent: thread.agentName,
            tool: pending.name,
            result,
            tokenCost: estimateTokensFromContent(typeof output === 'string' ? output : JSON.stringify(output)),
            ...(isError ? { isError: true, errorMessage: result.slice(0, 120) } : {}),
          },
        }, thread.rootSessionId)
      }
      return
    }

    if (type === 'custom_tool_call') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : null
      const name = typeof payload.name === 'string' ? payload.name : 'custom_tool'
      const rawInput = safeParseJson<Record<string, unknown>>(typeof payload.input === 'string' ? payload.input : '')
      const argsSummary = summarizeToolInput(name, rawInput)
      if (!callId || thread.pendingToolCalls.has(callId)) return
      thread.pendingToolCalls.set(callId, {
        callId,
        name,
        argsSummary,
        inputData: extractInputData(name, rawInput),
        startTime: Date.now(),
        rawArgs: rawInput || undefined,
      })
      if (emitEvents) {
        this.emit({
          time: this.elapsed(thread.rootSessionId),
          type: 'tool_call_start',
          payload: {
            agent: thread.agentName,
            tool: name,
            args: argsSummary,
            preview: `${name}: ${argsSummary}`.slice(0, 120),
            inputData: extractInputData(name, rawInput),
          },
        }, thread.rootSessionId)
      }
      return
    }

    if (type === 'custom_tool_call_output') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : null
      if (!callId) return
      const pending = thread.pendingToolCalls.get(callId)
      if (!pending) return
      thread.pendingToolCalls.delete(callId)
      const result = summarizeToolOutput(pending.name, payload.output)
      const isError = detectError(result)
      if (emitEvents) {
        this.emit({
          time: this.elapsed(thread.rootSessionId),
          type: 'tool_call_end',
          payload: {
            agent: thread.agentName,
            tool: pending.name,
            result,
            tokenCost: estimateTokensFromContent(typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output)),
            ...(isError ? { isError: true, errorMessage: result.slice(0, 120) } : {}),
          },
        }, thread.rootSessionId)
      }
      return
    }

    if (type === 'web_search_call' && emitEvents) {
      const action = (payload.action as Record<string, unknown> | undefined) || {}
      const argsSummary = summarizeToolInput('web_search_call', action)
      const result = summarizeToolOutput('web_search_call', action)
      this.emit({
        time: this.elapsed(thread.rootSessionId),
        type: 'tool_call_start',
        payload: {
          agent: thread.agentName,
          tool: 'web_search_call',
          args: argsSummary,
          preview: `web_search_call: ${argsSummary}`.slice(0, 120),
        },
      }, thread.rootSessionId)
      this.emit({
        time: this.elapsed(thread.rootSessionId),
        type: 'tool_call_end',
        payload: {
          agent: thread.agentName,
          tool: 'web_search_call',
          result,
          tokenCost: estimateTokensFromText(result),
        },
      }, thread.rootSessionId)
    }
  }

  private resolveWaitTarget(target: unknown, root: RootSessionState): string | null {
    if (typeof target !== 'string') return null
    if (root.taskNamesToAgents.has(target)) return root.taskNamesToAgents.get(target) || null
    if (this.threadStates.has(target)) return this.threadStates.get(target)?.agentName || null
    return null
  }

  private resetInactivity(threadId: string): void {
    const thread = this.threadStates.get(threadId)
    if (!thread) return
    const root = this.ensureRootSession(thread.rootSessionId)

    root.lastActivityTime = Date.now()
    if (root.sessionCompleted) {
      root.sessionCompleted = false
      this.emit({
        time: this.elapsed(root.sessionId),
        type: 'agent_spawn',
        payload: {
          name: ORCHESTRATOR_NAME,
          isMain: true,
          task: root.label,
          provider: 'codex',
        },
      }, root.sessionId)
      this._onSessionLifecycle.fire({ type: 'started', sessionId: root.sessionId, label: root.label })
    }

    if (root.inactivityTimer) clearTimeout(root.inactivityTimer)
    root.inactivityTimer = setTimeout(() => {
      if (!root.sessionCompleted) {
        root.sessionCompleted = true
        this.emit({
          time: this.elapsed(root.sessionId),
          type: 'agent_complete',
          payload: { name: ORCHESTRATOR_NAME, sessionEnd: true },
        }, root.sessionId)
        this._onSessionLifecycle.fire({ type: 'ended', sessionId: root.sessionId, label: root.label })
      }
    }, INACTIVITY_TIMEOUT_MS)

    if (!thread.isRoot) {
      if (thread.inactivityTimer) clearTimeout(thread.inactivityTimer)
      thread.inactivityTimer = setTimeout(() => {
        if (!thread.completed) this.completeThread(thread, 'Completed')
      }, INACTIVITY_TIMEOUT_MS)
    }
  }

  private completeThread(thread: ThreadState, summary: string): void {
    if (thread.completed) return
    thread.completed = true
    if (thread.inactivityTimer) {
      clearTimeout(thread.inactivityTimer)
      thread.inactivityTimer = null
    }
    if (thread.isRoot) {
      const root = this.ensureRootSession(thread.rootSessionId)
      if (!root.sessionCompleted) {
        root.sessionCompleted = true
        this.emit({
          time: this.elapsed(root.sessionId),
          type: 'agent_complete',
          payload: { name: ORCHESTRATOR_NAME, sessionEnd: true },
        }, root.sessionId)
        this._onSessionLifecycle.fire({ type: 'ended', sessionId: root.sessionId, label: root.label })
      }
      return
    }

    const parent = thread.parentThreadId
      ? (this.threadStates.get(thread.parentThreadId)?.agentName || ORCHESTRATOR_NAME)
      : ORCHESTRATOR_NAME
    this.emit({
      time: this.elapsed(thread.rootSessionId),
      type: 'subagent_return',
      payload: { child: thread.agentName, parent, summary: summary.slice(0, CHILD_SUMMARY_MAX) },
    }, thread.rootSessionId)
    this.emit({
      time: this.elapsed(thread.rootSessionId),
      type: 'agent_complete',
      payload: { name: thread.agentName },
    }, thread.rootSessionId)
  }

  private emitContextUpdate(thread: ThreadState): void {
    this.emit({
      time: this.elapsed(thread.rootSessionId),
      type: 'context_update',
      payload: {
        agent: thread.agentName,
        tokens: totalsForBreakdown(thread.contextBreakdown),
        breakdown: { ...thread.contextBreakdown },
      },
    }, thread.rootSessionId)
  }

  private elapsed(sessionId: string): number {
    const session = this.rootSessions.get(sessionId)
    if (!session) return 0
    return (Date.now() - session.sessionStartTime) / 1000
  }

  private emit(event: AgentEvent, sessionId?: string): void {
    this._onEvent.fire(sessionId ? { ...event, sessionId } : event)
  }

  dispose(): void {
    for (const thread of this.threadStates.values()) {
      thread.fileWatcher?.close()
      if (thread.pollTimer) clearInterval(thread.pollTimer)
      if (thread.inactivityTimer) clearTimeout(thread.inactivityTimer)
    }
    for (const session of this.rootSessions.values()) {
      if (session.inactivityTimer) clearTimeout(session.inactivityTimer)
    }
    if (this.scanInterval) clearInterval(this.scanInterval)
    this.threadStates.clear()
    this.rootSessions.clear()
    this._onEvent.dispose()
    this._onSessionDetected.dispose()
    this._onSessionLifecycle.dispose()
  }
}
