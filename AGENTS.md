# AGENTS.md — Taiga Manager Extension

## Purpose
This Pi extension provides a complete client for interacting with Taiga project management APIs. It handles authentication, URL negotiation (port 9000 vs 8001), and exposes tools for all common Taiga operations.

## Architecture

### Files
- **`api.ts`** — HTTP client library with:
  - JWT Bearer / Application token auto-detection
  - Automatic URL correction (`:9000` → strip port or `:8001`)
  - All REST API wrappers (issues, tasks, milestones, users, search)
- **`index.ts`** — Extension entry point with:
  - Session auth persistence via tool result details
  - Tool registrations (`pi.registerTool`)
  - Env var → session → env login priority chain
- **`types.ts`** — TypeScript interfaces for all Taiga API types

### Auth Flow (in order of priority)
1. Stored token in `authStore` from previous tool call
2. Session persistence (written by `taiga_login`)
3. Environment variables (`TAIGA_USER`, `TAIGA_PASSWORD`, `TAIGA_BASE_URL`)
4. Interactive prompt (if no env vars available)

### URL Correction Logic
The client auto-corrects URLs when requests fail:
1. If response is HTML (Frontend): strips port or tries `:8001` backend
2. If any non-HTML error on `:9000`: also tries stripped URL + `:8001` variants

### Environment Variables
| Name | Required | Default |
|------|----------|---------|
| `TAIGA_BASE_URL` | No | `https://api.taiga.io/api/v1` |
| `TAIGA_USER` | No (falls back to prompt) | - |
| `TAIGA_PASSWORD` | No (falls back to prompt) | - |
| `TAIGA_AUTH_TYPE` | No | `normal` |

## Important Notes
- All write operations (create/update/delete task/issue, add comment) require confirmation via `ctx.ui.confirm()`
- Use `taiga_list_task_statuses` / `taiga_list_issue_statuses` before creating/updating to get valid status IDs
- Issue #274 example: 403 errors from Taiga are permission-denied, not API URL issues — your instance routes correctly on port 9000
- The extension uses `node:https` (not `fetch`) for HTTP calls — no browser dependency

## Development
- TypeScript files compile in-place via Pi's extension loader
- Logs written to `$HOME/.cache/pi/taiga-manager.log` and `*-debug.log`
- To add a new tool, register it with `pi.registerTool()` following the pattern in `index.ts`
