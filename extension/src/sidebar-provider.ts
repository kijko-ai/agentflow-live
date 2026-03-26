import * as vscode from 'vscode'

export class SidebarTreeProvider implements vscode.TreeDataProvider<SidebarItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SidebarItem | undefined>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined)
  }

  getTreeItem(element: SidebarItem): vscode.TreeItem {
    return element
  }

  getChildren(element?: SidebarItem): SidebarItem[] {
    if (element) return []

    return [
      new SidebarItem('Open Visualizer', {
        command: 'agentVisualizer.open',
        title: 'Open Visualizer',
      }, 'play-circle', 'Launch the full Agent Flow visualizer'),

      new SidebarItem('Open to Side', {
        command: 'agentVisualizer.openToSide',
        title: 'Open to Side',
      }, 'split-horizontal', 'Open visualizer in a side panel'),

      new SidebarItem('Connect to Agent', {
        command: 'agentVisualizer.connectToAgent',
        title: 'Connect to Agent',
      }, 'radio-tower', 'Connect to a running agent session'),

      new SidebarItem('Configure Hooks', {
        command: 'agentVisualizer.configureHooks',
        title: 'Configure Hooks',
      }, 'settings-gear', 'Set up Claude Code hooks for live streaming'),
    ]
  }
}

class SidebarItem extends vscode.TreeItem {
  constructor(
    label: string,
    command: vscode.Command,
    icon: string,
    tooltip?: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.command = command
    this.iconPath = new vscode.ThemeIcon(icon)
    if (tooltip) this.tooltip = tooltip
  }
}
