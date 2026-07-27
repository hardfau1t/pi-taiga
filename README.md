# Taiga Manager Extension

A Pi Coding Agent extension for managing Taiga project management tool via REST API. Supports issues, tasks, milestones, and team collaboration features.

## Features

- 🔐 **Authentication** — Auto-login with env vars or manual login
- 📋 **Projects** — List & search projects
- 📌 **Issues** — Create/update/list/delete issues with filters
- ✅ **Tasks** — Task management with status tracking
- 🏷️ **Milestones** — Sprint/milestone management
- 🔍 **Search** — Global search across Taiga objects
- 💬 **Comments** — Add comments to tasks & issues
- 👤 **Users** — Team member management

## Installation

1. Copy this folder to your Pi agent extensions directory:
   ```bash
   cp -r taiga-manager ~/.pi/agent/extensions/
   ```

2. Set environment variables:
   ```bash
   export TAIGA_BASE_URL="https://your-taiga-instance.com"
   export TAIGA_USER="your-username"
   export TAIGA_PASSWORD="your-password"
   ```

3. Restart your Pi agent session

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `TAIGA_BASE_URL` | Taiga API base URL | `https://api.taiga.io/api/v1` |
| `TAIGA_USER` | Your username/email | - |
| `TAIGA_PASSWORD` | Your password | - |

## Available Tools

| Tool | Description |
|------|-------------|
| `taiga_login` | Authenticate with Taiga using env vars |
| `taiga_auth_check` | Check current authentication status |
| `taiga_get_current_user` | Get your profile info |
| `taiga_list_projects` | List all projects you belong to |
| `taiga_get_project_by_slug` | Get project details by slug |
| `taiga_list_task_statuses` | Get task statuses for a project |
| `taiga_list_issue_statuses` | Get issue statuses for a project |
| `taiga_list_tasks` | List/filter tasks in a project |
| `taiga_get_task` | Get task details by ID |
| `taiga_create_task` | Create new task (requires confirmation) |
| `taiga_update_task` | Update task fields (requires confirmation) |
| `taiga_delete_task` | Delete task permanently (requires confirmation) |
| `taiga_list_issues` | List/filter issues in a project |
| `taiga_get_issue` | Get issue details by ID |
| `taiga_create_issue` | Create new issue (requires confirmation) |
| `taiga_update_issue` | Update issue fields (requires confirmation) |
| `taiga_delete_issue` | Delete issue permanently (requires confirmation) |
| `taiga_add_comment` | Add comment to task/issue (requires confirmation) |
| `taiga_list_milestones` | List milestones/sprints for a project |
| `taiga_list_priorities` | Get available priorities |
| `taiga_list_severities` | Get available severities |
| `taiga_list_issue_types` | Get issue types (bug, task, etc.) |
| `taiga_search` | Search across Taiga objects |

## Usage Examples

### List open issues in a project
```
List open issues in project #14:
- taiga_list_issues(projectId=14, isClosed=false)
```

### Create a task
```
Create task in project #50:
- taiga_create_task(projectId=50, subject="Fix login bug", statusId=1)
```

### Check authentication
```
taiga_auth_check()
```

## Support

For issues or contributions, see the [AGENTS.md](./AGENTS.md) for implementation details.
