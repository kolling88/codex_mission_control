# Codex Mission Control

Codex Mission Control is a local VS Code dashboard for OpenAI Codex sessions, parent chats, and subagents.

The first version intentionally reads Codex JSONL session files instead of requiring native SQLite bindings. That makes the extension easier to package and more likely to work on any Windows machine where Codex writes to `%USERPROFILE%\.codex`.

## What it shows

- Parent chat cards.
- Subagent cards grouped under each parent.
- Active, idle, done, and error states.
- Workspace, Git branch, model/provider, tool count, and latest activity.
- Diagnostics for Codex home, session folder, session index, and state database.

## Data sources

By default the extension resolves Codex home in this order:

1. `codexMissionControl.codexHome` VS Code setting.
2. `CODEX_HOME` environment variable.
3. `%USERPROFILE%\.codex` on Windows, or `~/.codex` elsewhere.

The MVP reads:

- `.codex/sessions/**/*.jsonl`
- `.codex/session_index.jsonl` for diagnostics only
- `.codex/state_5.sqlite` for diagnostics only

A later version can use `state_5.sqlite` to enrich parent/child status from `thread_spawn_edges` and `threads`.

## Install from source

```powershell
git clone https://github.com/kolling88/codex_mission_control.git
cd codex_mission_control
npm install
npm run package
code --install-extension .\codex-mission-control-0.1.0.vsix
```

Then open VS Code and run:

```txt
Codex Mission Control: Open Dashboard
```

## Useful settings

```json
{
  "codexMissionControl.codexHome": "",
  "codexMissionControl.refreshIntervalMs": 3000,
  "codexMissionControl.maxSessions": 300,
  "codexMissionControl.activeThresholdMinutes": 10,
  "codexMissionControl.showPreview": true
}
```

Leave `codexMissionControl.codexHome` empty unless Codex uses a non-standard directory.

## Privacy

The extension reads local Codex files from your machine. It does not send transcripts anywhere. Preview text is shown only inside the local VS Code webview and can be disabled with `codexMissionControl.showPreview`.

## Build

```powershell
npm install
npm run compile
npm run package
```

GitHub Actions also builds a `.vsix` artifact on push and pull request.