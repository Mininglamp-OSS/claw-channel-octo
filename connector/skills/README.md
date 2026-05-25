# Connector Skills

The Octo skills are maintained in the [octo-cli](https://github.com/Mininglamp-OSS/octo-cli) repository under `skills/`:

- `octo-shared` — Fundamentals (auth, output format, flags, error taxonomy)
- `octo-messaging` — Messages, groups, threads, event polling
- `octo-files` — File upload/download, bot housekeeping
- `octo-matter` — Todo/task management

These skills are automatically synced from octo-cli via the connector's `_sync.github` + `skillsPath` configuration in `cli.json`.

## How it works

When WorkBuddy loads this plugin:
1. It reads `cli.json` → `_sync.github: "Mininglamp-OSS/octo-cli"` + `skillsPath: "skills"`
2. It fetches the skills from the octo-cli repo
3. AI Agent can then use `octo` CLI commands guided by the skill documentation

The skills teach the AI how to:
- Use `octo message send` / `octo message sync` for messaging
- Use `octo group list` / `octo group members` for group management
- Use `octo thread create` / `octo thread list` for threads
- Use `octo file upload` / `octo file download` for files
- Use `octo matter create` / `octo matter list` for tasks

All commands use `$OCTO_BOT_TOKEN` and `$OCTO_API_BASE_URL` env vars (injected by plugin.json userConfig).
