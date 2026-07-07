import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  collectMissionControlData,
  getDiagnostics,
  MissionControlSettings,
  resolveCodexHome
} from './codex';
import { getWebviewHtml } from './webviewHtml';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new MissionControlProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codexMissionControl.dashboard', provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codexMissionControl.openDashboard', async () => {
      await vscode.commands.executeCommand('codexMissionControl.dashboard.focus');
    }),
    vscode.commands.registerCommand('codexMissionControl.refresh', async () => {
      await provider.refresh();
    }),
    vscode.commands.registerCommand('codexMissionControl.showDiagnostics', async () => {
      await provider.showDiagnostics();
    }),
    vscode.commands.registerCommand('codexMissionControl.openCodexHome', async () => {
      await revealPath(resolveCodexHome(readSettings().codexHome));
    })
  );
}

export function deactivate(): void {
  // VS Code disposes registered subscriptions automatically.
}

class MissionControlProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private refreshTimer?: NodeJS.Timeout;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
    };

    webviewView.webview.html = getWebviewHtml(webviewView.webview, this.extensionUri);

    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      await this.handleMessage(message);
    });

    webviewView.onDidDispose(() => {
      this.stopAutoRefresh();
      this.view = undefined;
    });

    this.startAutoRefresh();
  }

  async refresh(): Promise<void> {
    if (!this.view) {
      return;
    }

    const settings = readSettings();

    try {
      const data = await collectMissionControlData(settings);
      this.view.webview.postMessage({ type: 'data', data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.view.webview.postMessage({ type: 'error', message });
    }
  }

  async showDiagnostics(): Promise<void> {
    const settings = readSettings();
    const diagnostics = await getDiagnostics(settings);

    if (this.view) {
      this.view.webview.postMessage({ type: 'diagnostics', diagnostics });
    }

    await vscode.window.showInformationMessage(
      `Codex Mission Control: ${diagnostics.jsonlFileCount} JSONL sessions found in ${diagnostics.sessionsRoot}`
    );
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
      case 'refresh':
        await this.refresh();
        break;
      case 'showDiagnostics':
        await this.showDiagnostics();
        break;
      case 'openCodexHome':
        await revealPath(resolveCodexHome(readSettings().codexHome));
        break;
      case 'openFile':
        if (typeof message.filePath === 'string') {
          await openFile(message.filePath);
        }
        break;
      case 'revealPath':
        if (typeof message.path === 'string') {
          await revealPath(message.path);
        }
        break;
      default:
        break;
    }
  }

  private startAutoRefresh(): void {
    this.stopAutoRefresh();
    const intervalMs = readSettings().refreshIntervalMs;
    if (intervalMs <= 0) {
      return;
    }
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, intervalMs);
  }

  private stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }
}

interface WebviewMessage {
  type: string;
  filePath?: string;
  path?: string;
}

function readSettings(): MissionControlSettings & { refreshIntervalMs: number } {
  const config = vscode.workspace.getConfiguration('codexMissionControl');
  return {
    codexHome: config.get<string>('codexHome', ''),
    refreshIntervalMs: config.get<number>('refreshIntervalMs', 3000),
    maxSessions: config.get<number>('maxSessions', 300),
    activeThresholdMinutes: config.get<number>('activeThresholdMinutes', 10),
    showPreview: config.get<boolean>('showPreview', true)
  };
}

async function openFile(filePath: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.window.showTextDocument(document, { preview: true });
}

async function revealPath(targetPath: string): Promise<void> {
  const normalized = path.resolve(targetPath);
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(normalized));
}
