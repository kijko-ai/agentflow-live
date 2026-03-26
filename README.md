# AgentFlow Live

Real-time visualization of Claude Code and Codex agent orchestration. Watch your agents think, branch, and coordinate as they work.

![AgentFlow Live visualization](https://res.cloudinary.com/dxlvclh9c/image/upload/v1773924941/screenshot_e7yox3.png)

## Installation

### From VSIX (recommended)

```bash
# Clone the repo
git clone https://github.com/kijko-ai/agentflow-live.git
cd agentflow-live/extension

# Install dependencies
npm install

# Install web dependencies (needed for webview build)
cd ../web && pnpm install && cd ../extension

# Build and package
npm run build:all
npx @vscode/vsce package --no-dependencies

# Install the extension
code --install-extension agentflow-live-1.0.0.vsix
```

### Quick install (pre-built)

If a `.vsix` file is already available in the `extension/` directory:

```bash
code --install-extension extension/agentflow-live-1.0.0.vsix
```

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [pnpm](https://pnpm.io/) (for web dependencies)
- VS Code 1.85 or later

## Getting Started

1. Install the extension using one of the methods above
2. Look for the **AgentFlow Live icon** in the Activity Bar (left sidebar) and click it
3. In the sidebar panel, click **Open Visualizer**
4. Start a Claude Code or Codex session in your workspace — AgentFlow Live will auto-detect it

You can also open the visualizer via:
- **Command Palette** (`Ctrl+Shift+P` / `Cmd+Shift+P`) → `AgentFlow Live: Open Agent Flow`
- **Status bar** → click `AgentFlow Live` in the bottom-left
- **Keyboard shortcut** → `Ctrl+Alt+A` / `Cmd+Alt+A`

## Features

- **Live agent visualization** — Interactive node graph with real-time tool calls, branching, and return flows
- **Auto-detect Claude Code and Codex sessions** — Discovers active sessions in your workspace and streams events
- **Claude Code hooks** — Lightweight HTTP hook server receives events directly from Claude Code for zero-latency streaming
- **Activity Bar icon** — One-click access from the VS Code sidebar
- **Multi-session support** — Track multiple concurrent agent sessions with tabs
- **Interactive canvas** — Pan, zoom, click agents and tool calls to inspect details
- **Timeline & transcript panels** — Review execution timeline, file attention heatmap, and message transcript
- **JSONL log file support** — Replay or watch agent activity from any JSONL event log

## Claude Code Hooks

AgentFlow Live automatically configures Claude Code hooks the first time you open the panel. These forward events from Claude Code for zero-latency streaming.

To manually reconfigure hooks, run **AgentFlow Live: Configure Claude Code Hooks** from the Command Palette.

## Codex Sessions

Codex sessions are discovered directly from `~/.codex/sessions` and grouped by parent session so spawned Codex subagents appear inside the same graph instead of as unrelated tabs.

## JSONL Event Log

You can also point AgentFlow Live at a JSONL event log file:

1. Set `agentVisualizer.eventLogPath` in your VS Code settings to the path of a `.jsonl` file
2. AgentFlow Live will tail the file and visualize events as they arrive

## Commands

| Command | Description |
|---------|-------------|
| `Agent Flow: Open Agent Flow` | Open the visualizer panel |
| `Agent Flow: Open Agent Flow to Side` | Open in a side editor column |
| `Agent Flow: Connect to Running Agent` | Manually connect to an agent session |
| `Agent Flow: Configure Claude Code Hooks` | Set up Claude Code hooks for live streaming |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+A` (Win/Linux) / `Cmd+Alt+A` (Mac) | Open AgentFlow Live |
| `Ctrl+Alt+Shift+A` (Win/Linux) / `Cmd+Alt+Shift+A` (Mac) | Open AgentFlow Live |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `agentVisualizer.devServerPort` | `0` | Development server port (0 = production mode) |
| `agentVisualizer.eventLogPath` | `""` | Path to a JSONL event log file to watch |
| `agentVisualizer.autoOpen` | `false` | Auto-open when an agent session starts |

## Development

```bash
# Watch mode (extension)
cd extension && npm run watch

# Dev server (webview)
cd web && pnpm run dev
```

Set `agentVisualizer.devServerPort` to `3002` in VS Code settings to use the dev server for hot-reload during development.

## Uninstalling

```bash
code --uninstall-extension codex-tools.agentflow-live
```

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.

Based on [Agent Flow](https://github.com/patoles/agent-flow) by Simon Patole.
