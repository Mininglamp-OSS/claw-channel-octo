# Contributing to claw-channel-octo

## Prerequisites

- Node.js 20+
- npm

## Development Workflow

```bash
# Install dependencies
npm install

# Type check
npm run type-check

# Run tests
npm test

# Build
npm run build
```

## Code Style

- TypeScript strict mode — no implicit any
- Logger params use `unknown[]`, never `any[]`
- ESM modules (`import`/`export`, `.js` extensions in imports)
- Prefer `const` over `let`

## Testing

- Use Node.js built-in test runner (`node:test` + `node:assert/strict`)
- No external test frameworks
- Test files go in `src/__tests__/*.test.ts`
- Mock HTTP calls via injectable `httpClient` parameter

## Pull Requests

1. Fork the repo
2. Create a feature branch from `main`
3. Write code + tests
4. Ensure `npm run type-check` and `npm test` pass
5. Open PR against `main`
6. CI must be green before merge

## Architecture

See [DESIGN.md](./DESIGN.md) for architecture overview.

Key modules:
- `src/index.ts` — Plugin factory (`createOctoPlugin`)
- `src/octo-gateway.ts` — WebSocket connection + heartbeat + auto-reconnect
- `src/octo-outbound.ts` — Reply via Octo REST API
- `src/octo-config.ts` — Config resolver from settings.json
