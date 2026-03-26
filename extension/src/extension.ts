import * as vscode from 'vscode'
import { VisualizerPanel } from './webview-provider'
import { SidebarTreeProvider } from './sidebar-provider'
import { JsonlEventSource } from './event-source'
import { HookServer } from './hook-server'
import { SessionWatcher } from './session-watcher'
import { CodexSessionWatcher } from './codex-session-watcher'
import { AgentEvent, SessionInfo, WebviewToExtensionMessage } from './protocol'
import {
  ORCHESTRATOR_NAME, HOOK_SERVER_NOT_STARTED,
  SESSION_ID_DISPLAY, STATUS_MESSAGE_DURATION_MS,
} from './constants'
import {
  promptHookSetupIfNeeded,
  configureClaudeHooks, migrateHttpHooks,
} from './hooks-config'
import {
  writeDiscoveryFile, removeDiscoveryFile,
  ensureHookScript,
} from './discovery'
import { createLogger } from './logger'

const log = createLogger('Extension')

/** Convert orchestrator agent_complete to agent_idle unless it's a session end.
 *  Prevents premature "completed" state during long API calls. */
function filterOrchestratorCompletion(event: AgentEvent): AgentEvent | null {
  if (event.type !== 'agent_complete') return event
  const agentName = event.payload?.agent ?? event.payload?.name
  const isOrchestrator = agentName === ORCHESTRATOR_NAME || !agentName
  if (!isOrchestrator) return event
  if (event.payload?.sessionEnd) return event
  return { ...event, type: 'agent_idle' }
}

let eventSource: JsonlEventSource | undefined
let hookServer: HookServer | undefined
let claudeSessionWatcher: SessionWatcher | undefined
let codexSessionWatcher: CodexSessionWatcher | undefined
let runtimeStartPromise: Promise<void> | undefined

export async function activate(context: vscode.ExtensionContext) {
  log.info('Extension activated')

  // Activity bar sidebar tree view
  const sidebarProvider = new SidebarTreeProvider()
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('agentFlowLive.launcher', sidebarProvider),
  )

  const launchButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  launchButton.name = 'AgentFlow Live'
  launchButton.text = 'AgentFlow Live'
  launchButton.tooltip = 'Open AgentFlow Live'
  launchButton.command = 'agentVisualizer.open'
  launchButton.show()
  context.subscriptions.push(launchButton)

  context.subscriptions.push(
    vscode.commands.registerCommand('agentVisualizer.open', async () => {
      const panel = VisualizerPanel.create(context.extensionUri, vscode.ViewColumn.One)
      wirePanel(panel)
      promptHookSetupIfNeeded(context)
      await ensureRuntimeStarted(context)
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('agentVisualizer.openToSide', async () => {
      const panel = VisualizerPanel.create(context.extensionUri, vscode.ViewColumn.Beside)
      wirePanel(panel)
      promptHookSetupIfNeeded(context)
      await ensureRuntimeStarted(context)
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('agentVisualizer.connectToAgent', async () => {
      const choice = await vscode.window.showQuickPick(
        [
          { label: '$(radio-tower) Claude Code Hooks', description: 'Auto-configure Claude hooks for live streaming', value: 'hooks' },
          { label: '$(file) Watch JSONL File', description: 'Watch a file for agent events', value: 'jsonl' },
          { label: '$(play) Mock Data', description: 'Use built-in demo scenario', value: 'mock' },
        ],
        { placeHolder: 'Select event source' },
      )

      if (!choice) { return }

      if (choice.value === 'hooks') {
        await configureClaudeHooks()
      } else if (choice.value === 'jsonl') {
        const fileUri = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: { 'JSONL Files': ['jsonl', 'json', 'ndjson'] },
          title: 'Select agent event log file',
        })

        if (fileUri?.[0]) {
          connectToJsonl(fileUri[0].fsPath, context)
        }
      } else if (choice.value === 'mock') {
        const panel = VisualizerPanel.getCurrent()
        if (panel) {
          panel.postMessage({ type: 'config', config: { mode: 'replay', autoPlay: true, showMockData: true } })
        }
      }
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('agentVisualizer.configureHooks', async () => {
      await configureClaudeHooks()
    }),
  )

  vscode.window.registerWebviewPanelSerializer(VisualizerPanel.viewType, {
    async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel) {
      const panel = VisualizerPanel.revive(webviewPanel, context.extensionUri)
      wirePanel(panel)
      await ensureRuntimeStarted(context)
    },
  })
}

async function ensureRuntimeStarted(context: vscode.ExtensionContext): Promise<void> {
  if (!runtimeStartPromise) {
    runtimeStartPromise = startRuntime(context).catch((err) => {
      runtimeStartPromise = undefined
      throw err
    })
  }
  await runtimeStartPromise
}

async function startRuntime(context: vscode.ExtensionContext): Promise<void> {
  if (hookServer || claudeSessionWatcher || codexSessionWatcher) { return }

  hookServer = new HookServer()
  context.subscriptions.push(hookServer)

  let hookPort: number
  try {
    hookPort = await hookServer.start()
  } catch (err) {
    log.error('Failed to start hook server:', err)
    hookPort = HOOK_SERVER_NOT_STARTED
  }

  if (hookPort === HOOK_SERVER_NOT_STARTED) {
    log.info('Hook server skipped (another instance owns the port) — using session watcher only')
  } else {
    log.info(`Hook server running on port ${hookPort}`)

    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (workspace) {
      ensureHookScript()
      writeDiscoveryFile(hookPort, workspace)
      migrateHttpHooks()
    }

    hookServer.onEvent((event) => {
      const panel = VisualizerPanel.getCurrent()
      if (!panel || !panel.isReady) { return }

      const eventSessionId = event.sessionId
      const sessionWatcherHandlesThis = eventSessionId
        ? (claudeSessionWatcher?.isSessionActive(eventSessionId) || codexSessionWatcher?.isSessionActive(eventSessionId))
        : claudeSessionWatcher?.isActive()

      if (sessionWatcherHandlesThis) {
        const agentName = event.payload?.agent ?? event.payload?.name
        const isOrchestrator = agentName === ORCHESTRATOR_NAME || !agentName

        if (isOrchestrator) {
          const filtered = filterOrchestratorCompletion(event)
          if (filtered) panel.sendEvent(filtered)
          return
        }

        const subagentLifecycleEvents = ['agent_spawn', 'subagent_dispatch', 'subagent_return', 'agent_complete']
        if (subagentLifecycleEvents.includes(event.type)) return

        panel.sendEvent(event)
        return
      }
      panel.sendEvent(event)
      panel.setConnectionStatus('watching', `Claude hooks (:${hookPort})`)
    })
  }

  claudeSessionWatcher = new SessionWatcher()
  context.subscriptions.push(claudeSessionWatcher)

  claudeSessionWatcher.onEvent((event) => {
    const panel = VisualizerPanel.getCurrent()
    if (!panel || !panel.isReady) { return }
    const filtered = filterOrchestratorCompletion(event)
    if (filtered) panel.sendEvent(filtered)
  })

  claudeSessionWatcher.onSessionDetected((sessionId) => {
    updateSessionStatus(sessionId)
  })

  claudeSessionWatcher.onSessionLifecycle((lifecycle) => {
    handleSessionLifecycle(lifecycle)
  })

  claudeSessionWatcher.start()

  codexSessionWatcher = new CodexSessionWatcher()
  context.subscriptions.push(codexSessionWatcher)

  codexSessionWatcher.onEvent((event) => {
    const panel = VisualizerPanel.getCurrent()
    if (!panel || !panel.isReady) { return }
    const filtered = filterOrchestratorCompletion(event)
    if (filtered) panel.sendEvent(filtered)
  })

  codexSessionWatcher.onSessionDetected((sessionId) => {
    updateSessionStatus(sessionId)
  })

  codexSessionWatcher.onSessionLifecycle((lifecycle) => {
    handleSessionLifecycle(lifecycle)
  })

  codexSessionWatcher.start()
}

function getActiveSessions(): SessionInfo[] {
  return [
    ...(claudeSessionWatcher?.getActiveSessions() ?? []),
    ...(codexSessionWatcher?.getActiveSessions() ?? []),
  ]
}

function updateSessionStatus(sessionId: string): void {
  const panel = VisualizerPanel.getCurrent()
  if (panel) {
    const sessionCount = getActiveSessions().length
    panel.setConnectionStatus('watching', sessionCount > 1
      ? `${sessionCount} sessions`
      : `Session ${sessionId.slice(0, SESSION_ID_DISPLAY)}`)
  }
  vscode.window.setStatusBarMessage(`Agent Visualizer: watching session ${sessionId.slice(0, SESSION_ID_DISPLAY)}`, STATUS_MESSAGE_DURATION_MS)
}

function handleSessionLifecycle(lifecycle: { type: 'started' | 'ended' | 'updated'; sessionId: string; label: string }): void {
  const panel = VisualizerPanel.getCurrent()
  if (!panel) { return }
  const session = getActiveSessions().find((item) => item.id === lifecycle.sessionId)
  if (lifecycle.type === 'started') {
    panel.postMessage({
      type: 'session-started',
      session: {
        id: lifecycle.sessionId,
        label: lifecycle.label,
        provider: session?.provider || 'claude',
        status: 'active' as const,
        startTime: Date.now(),
        lastActivityTime: Date.now(),
      },
    })
  } else if (lifecycle.type === 'updated') {
    panel.postMessage({ type: 'session-updated', sessionId: lifecycle.sessionId, label: lifecycle.label })
  } else {
    panel.postMessage({ type: 'session-ended', sessionId: lifecycle.sessionId })
  }
}

function wirePanel(panel: VisualizerPanel): void {
  if (panel.isWired) { return }
  panel.markWired()
  let readyHandled = false
  panel.onCommand((message: WebviewToExtensionMessage) => {
    switch (message.type) {
      case 'ready':
        if (readyHandled) { return }
        readyHandled = true
        log.info('Webview ready')
        panel.markReady()
        panel.postMessage({ type: 'reset', reason: 'panel-reopened' })
        const sessions = getActiveSessions()
        if (sessions.length > 0) {
          panel.postMessage({ type: 'session-list', sessions })
          claudeSessionWatcher?.replaySessionStart(sessions.filter(s => s.provider === 'claude').map(s => s.id))
          codexSessionWatcher?.replaySessionStart(sessions.filter(s => s.provider === 'codex').map(s => s.id))
        }
        if (hookServer && hookServer.getPort() > 0) {
          panel.setConnectionStatus('watching', `Hooks :${hookServer.getPort()} + Claude/Codex sessions`)
        } else {
          panel.setConnectionStatus('watching', 'Claude/Codex sessions')
        }
        break

      case 'request-connect':
        vscode.commands.executeCommand('agentVisualizer.connectToAgent')
        break

      case 'request-disconnect':
        disconnectEventSource()
        panel.setConnectionStatus('disconnected', '')
        break

      case 'open-file':
        handleOpenFile(message.filePath, message.line)
        break

      case 'log': {
        const webviewLog = createLogger('Webview')
        const logFn = message.level === 'error' ? webviewLog.error
          : message.level === 'warn' ? webviewLog.warn
          : webviewLog.info
        logFn(message.message)
        break
      }
    }
  })
}

function connectToJsonl(filePath: string, context: vscode.ExtensionContext): void {
  disconnectEventSource()

  eventSource = new JsonlEventSource(filePath)
  context.subscriptions.push(eventSource)

  const panel = VisualizerPanel.getCurrent()
  if (!panel) { return }

  eventSource.onEvent((event) => {
    panel.sendEvent(event)
  })

  eventSource.onStatus((status) => {
    panel.setConnectionStatus(
      status === 'connected' ? 'watching' : 'disconnected',
      filePath,
    )
  })

  eventSource.start()
}

function disconnectEventSource(): void {
  if (eventSource) {
    eventSource.dispose()
    eventSource = undefined
  }
}

async function handleOpenFile(filePath: string, line?: number): Promise<void> {
  try {
    const uri = vscode.Uri.file(filePath)
    const doc = await vscode.workspace.openTextDocument(uri)
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
    })
    if (line && line > 0) {
      const pos = new vscode.Position(line - 1, 0)
      editor.selection = new vscode.Selection(pos, pos)
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
    }
  } catch (err) {
    log.error(`Failed to open file: ${filePath}`, err)
  }
}

export function deactivate(): void {
  disconnectEventSource()

  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (workspace) {
    removeDiscoveryFile(workspace)
  }

  if (hookServer) {
    hookServer.dispose()
    hookServer = undefined
  }
  if (claudeSessionWatcher) {
    claudeSessionWatcher.dispose()
    claudeSessionWatcher = undefined
  }
  if (codexSessionWatcher) {
    codexSessionWatcher.dispose()
    codexSessionWatcher = undefined
  }
  runtimeStartPromise = undefined
}
