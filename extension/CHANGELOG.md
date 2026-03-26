# Changelog

## 0.4.14

- Declared `extensionKind` explicitly for UI/workspace execution so Remote SSH windows do not rely on inferred host placement
- Kept the visible status bar launcher and lazy runtime startup

## 0.4.13

- Replaced the incorrect editor-toolbar launcher with a workspace-level status bar launch button
- Delayed hook server and session watcher startup until Agent Flow is actually opened
- Bumped the extension version so the corrected launch UI ships in a fresh VSIX

## 0.4.12

- Added a visible Agent Flow launch button to the VS Code editor title bar
- Bumped the extension version so the new UI button ships in a fresh VSIX

## 0.4.11

- Fixed the launch shortcut so it opens Agent Flow directly through the main open command
- Removed the redundant launcher alias command to avoid duplicate Command Palette entries
- Bumped the extension version so packaged VSIX installs update cleanly

## 0.4.10

- Added Codex session auto-detection alongside the existing Claude Code flow
- Added Codex tool/subagent/session parsing with shared graph visualization output
- Updated the UI and metadata to distinguish Claude Code and Codex sessions
- Added a dedicated shortcut alias for opening Agent Flow

## 0.4.7

- Fix: reset button in review mode no longer breaks the extension
  - Active agents are preserved across reset; only completed state and visual history are cleared
  - Event log is trimmed to retain agent_spawn events so review mode seeking works correctly

## 0.4.6

- Updated README: clarified automatic hook configuration behavior
- Updated description and tagline

## 0.4.5

- Initial public release
- Real-time visualization of Claude Code agent execution flows
- Auto-detection of Claude Code sessions via transcript watching
- Claude Code hooks integration for live event streaming
- Multi-session support with session tabs
- Interactive canvas with agent nodes, tool calls, and particles
- Timeline, file attention, and transcript panels
- JSONL event log file watching
