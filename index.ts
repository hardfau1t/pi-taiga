// ============================================================================
// Taiga Issue & Task Manager — pi Extension
// ============================================================================
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

import type {
  AuthResponse,
  TaigaUser,
  TaigaProject,
  TaigaTask,
  TaigaIssue,
  TaigaStatus,
} from "./types.js";

import * as api from "./api.js";
import type { TaigaConfig } from "./api.js";

// --------------------------------------------------------------------------
// Auth state — persisted in session via tool result details so branches
// survive restarts.  Key: "taiga-auth" stored on every auth-relevant call.
// --------------------------------------------------------------------------

function makeConfig(configStore: Record<string, unknown>): TaigaConfig {
  return {
    baseUrl: (configStore["baseUrl"] as string) ?? "https://api.taiga.io/api/v1",
    authToken: (configStore["authToken"] as string) ?? null,
    username: (configStore["username"] as string) ?? null,
    password: (configStore["password"] as string) ?? null,
  };
}

function storeConfig(configStore: Record<string, unknown>, cfg: TaigaConfig): void {
  configStore["baseUrl"] = cfg.baseUrl;
  if (cfg.authToken) configStore["authToken"] = cfg.authToken;
  if (cfg.username) configStore["username"] = cfg.username;
  if (cfg.password) configStore["password"] = cfg.password;
}

function loadConfigFromSession(ctx: ReturnType<ExtensionAPI>["sessionManager"]): TaigaConfig {
  const entries = ctx.getEntries();
  // Walk backward to find the most recent taiga-auth state
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "taiga_login") {
      const d = entry.message.details as Record<string, unknown> | undefined;
      if (d?.authState) return makeConfig(d.authState as Record<string, unknown>);
    }
  }
  return { baseUrl: "https://api.taiga.io/api/v1" };
}

// --------------------------------------------------------------------------
// Ensure we have auth; fall back to env vars or interactive prompt.
// Priority: 1) stored token, 2) session state, 3) environment variables,
//            4) interactive prompt
// --------------------------------------------------------------------------

async function ensureAuth(configStore: Record<string, unknown>, ctx: any, authStore: Record<string, unknown>): Promise<TaigaConfig> {
  let cfg = makeConfig(configStore);

  // Priority 1: already have a token in memory
  if (cfg.authToken) return cfg;

  // Priority 2: session has stored auth from earlier
  if (ctx && ctx.sessionManager) {
    const sessionCfg = loadConfigFromSession(ctx.sessionManager);
    if (sessionCfg.authToken) {
      configStore["authToken"] = sessionCfg.authToken;
      configStore["username"] = sessionCfg.username ?? "";
      configStore["password"] = sessionCfg.password ?? "";
      authStore["authToken"] = sessionCfg.authToken;
      authStore["username"] = sessionCfg.username ?? "";
      authStore["baseUrl"] = sessionCfg.baseUrl;
      return makeConfig(configStore);
    }
  }

  // Priority 3: environment variables
  const envUser = process.env.TAIGA_USER;
  const envPass = process.env.TAIGA_PASSWORD;
  if (envUser && envPass) {
    const baseUrl = process.env.TAIGA_BASE_URL || "https://api.taiga.io/api/v1";
    cfg.baseUrl = baseUrl;
    configStore["baseUrl"] = baseUrl;

    const result = await api.login(cfg, envUser, envPass);
    if (!result.ok) {
      throw new Error(`Login failed from env vars: ${result.error}`);
    }
    configStore["authToken"] = result.data.auth_token;
    configStore["username"] = envUser;
    configStore["password"] = envPass;
    configStore["baseUrl"] = baseUrl;
    authStore["authToken"] = result.data.auth_token;
    authStore["username"] = envUser;
    return makeConfig(configStore);
  }

  // Priority 4: prompt user interactively
  const username = await ctx.ui.input("Taiga username or email:", "");
  if (!username) throw new Error("Username required");

  const password = await ctx.ui.input("Taiga password:", "");
  if (!password) throw new Error("Password required");

  const baseUrlInput = process.env.TAIGA_BASE_URL || (await ctx.ui.input("Taiga API base URL (press Enter for default):", "https://api.taiga.io/api/v1"));
  cfg.baseUrl = baseUrlInput || "https://api.taiga.io/api/v1";

  configStore["username"] = username;
  configStore["password"] = password;
  configStore["baseUrl"] = cfg.baseUrl;

  const result = await api.login(cfg, username, password);
  if (!result.ok) {
    throw new Error(`Login failed: ${result.error}`);
  }

  configStore["authToken"] = result.data.auth_token;
  authStore["authToken"] = result.data.auth_token;
  return makeConfig(configStore);
}





// --------------------------------------------------------------------------
// Extension factory
// --------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Auth state carried across tool calls via details persistence
  let authStore: Record<string, unknown> = {};

  // --------------------------------------------------------------------------
  // Helper functions for rendering lists and formatting entries
  // --------------------------------------------------------------------------

  function renderList<T>(items: T[], formatter: (item: T) => string): string {
    if (!items.length) return "_No items found._";
    const lines = items.map(formatter);
    return lines.join("\n")
      .replace(/^/gm, "• ");
  }

  function formatProject(p: TaigaProject): string {
    return `**#${p.id}** ${p.name} (slug: \`${p.slug}\`)`;
  }

  function formatStatus(s: TaigaStatus): string {
    return `[${s.color.padEnd(7)}] ${s.name}${s.is_closed ? " (closed)" : ""}`;
  }

  function taskRow(t: TaigaTask): string {
    const status = t.status_extra_info;
    const assignee = t.assigned_to_extra_info
      ? ` → ${t.assigned_to_extra_info.full_name_display}`
      : " (unassigned)";
    return `**#${t.ref}** [${status?.color}] ${status?.name}\`$${t.subject.substring(0, 60)}\`${t.subject.length > 60 ? "…" : ""}]${assignee}`;
  }

  function issueRow(t: TaigaIssue): string {
    const status = t.status_extra_info;
    const assignee = t.assigned_to_extra_info
      ? ` → ${t.assigned_to_extra_info.full_name_display}`
      : " (unassigned)";
    return `**#${t.ref}** [${status?.color}] ${status?.name}\`$${t.subject.substring(0, 60)}\`${t.subject.length > 60 ? "…" : ""}]${assignee}`;
  }

  function formatUser(u: TaigaUser): string {
    return `**#${u.id}** ${u.full_name_display} (@${u.username})`;
  }

  // ---- session_start: load config and print status widget (lazy auth) ----
  // Note: we deliberately avoid calling api.login() here. Authentication is
  // deferred until the first taiga_* tool call, which uses ensureAuth() to
  // authenticate on demand (once per session via the authStore closure).
  pi.on("session_start", async (_event, ctx) => {
    let displayName = "(none)";
    let baseUrl = "https://api.taiga.io/api/v1";
    let authMethod = "none";

    // 1) Session persistence (token from earlier tool call in this session)
    const loaded = loadConfigFromSession(ctx.sessionManager);
    if (loaded.authToken) {
      baseUrl = loaded.baseUrl;
      displayName = loaded.username ?? "(not set)";
      authMethod = "session";
      // Restore into authStore so subsequent tools find the token immediately
      authStore["authToken"] = loaded.authToken;
      authStore["username"] = loaded.username ?? "";
      authStore["baseUrl"] = loaded.baseUrl;
    }

    // 2) Environment variables status (for display only)
    const envUser = process.env.TAIGA_USER;
    const envPass = process.env.TAIGA_PASSWORD;
    const envBaseUrl = process.env.TAIGA_BASE_URL;
    baseUrl = envBaseUrl || baseUrl;

    // 3) Determine auth method and status
    if (authMethod === "session") {
      // Already authenticated via session persistence — no need to check env vars
      authMethod = "session";
    } else if (envUser && envPass) {
      // Env vars are available but login is deferred to first tool call
      displayName = envUser;
      authMethod = "env (ready, lazy)";
    } else if (!loaded.authToken) {
      // No session token and no env vars — warn user
      ctx.ui.notify(
        "Taiga manager loaded - no TAIGA_USER/TAIGA_PASSWORD set. Call taiga_login to authenticate.",
        "warning",
      );
    }

    // --- Display config info widget above editor ---
    const isLoggedIn = !!authStore["authToken"];
    
    if (isLoggedIn) {
      ctx.ui.notify(`Taiga Manager — OK Authenticated (${authMethod})\nUser: ${displayName}\nURL: ${baseUrl || '(default)'}`, "info");
    } else if (!envUser || !envPass) {
      // Only warn if env vars aren't available (if they are, we're ready to lazy-auth)
      ctx.ui.notify(`Taiga Manager — Not logged in (${authMethod})`, "warning");
    }
  });

  // ====================================================================
  // Tool: taiga_login
  // ====================================================================
  pi.registerTool({
    name: "taiga_login",
    label: "Taiga Login",
    description: "Trigger Taiga authentication using environment variables (TAIGA_USER / TAIGA_PASSWORD). Also verifies the credentials work.",
    parameters: Type.Object({}),
    promptSnippet: "Authenticate with Taiga using env vars",
    promptGuidelines: [
      "Taiga auth uses TAIGA_USER and TAIGA_PASSWORD environment variables — no username/password params needed.",
      "Call taiga_login to verify or trigger the login; subsequent taiga_* tools auto-inherit the token.",
    ],
    async execute() {
      // Already authenticated in this session — skip redundant login
      if (authStore["authToken"]) {
        const user = authStore["username"] || "current user";
        return { content: [{ type: "text", text: `✅ Already authenticated as **${user}** (@${user}). No re-authentication needed.` }] };
      }

      const envUser = process.env.TAIGA_USER;
      const envPass = process.env.TAIGA_PASSWORD;

      if (!envUser || !envPass) {
        return { content: [{ type: "text", text: `❌ taiga_login requires TAIGA_USER and TAIGA_PASSWORD environment variables to be set.` }] };
      }

      const baseUrl = process.env.TAIGA_BASE_URL || "https://api.taiga.io/api/v1";
      authStore["baseUrl"] = baseUrl;

      const result = await api.login({ baseUrl }, envUser, envPass);
      if (!result.ok) return { content: [{ type: "text", text: `❌ Login failed: ${result.error}` }] };

      authStore["authToken"] = result.data.auth_token;
      authStore["username"] = envUser;

      const user = result.data.user;
      return {
        content: [{
          type: "text",
          text: `✅ Authenticated as **${user.full_name_display}** (@${user.username})\n`
            + `Auth token stored. You can now use taiga_* tools.\n`
            + `API URL: \`${baseUrl}\``,
        }],
        details: { authState: { ...authStore, password: "" }, loggedInUser: user },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_auth_check (shows current auth status)
  // ====================================================================
  pi.registerTool({
    name: "taiga_auth_check",
    label: "Taiga Auth Check",
    description: "Show current Taiga authentication status.",
    parameters: Type.Object({}),
    async execute() {
      const hasToken = !!authStore["authToken"];
      const user = authStore["username"] || "(not logged in)";
      const url = (authStore["baseUrl"] as string) || "https://api.taiga.io/api/v1";
      const envSource = process.env.TAIGA_USER ? "env vars (ready)" : "no creds set";
      return {
        content: [{ type: "text", text: `Auth: ${hasToken ? "✅ token stored" : "❌ no token"}\nUser: ${user}\nURL: ${url}\nSource: ${envSource}` }],
        details: {},
      };
    },
  });

  // ====================================================================
  // Tool: taiga_get_current_user
  // ====================================================================
  pi.registerTool({
    name: "taiga_get_current_user",
    label: "Taiga Current User",
    description: "Get the currently authenticated Taiga user's profile.",
    parameters: Type.Object({}),
    promptSnippet: "Show current authenticated Taiga user profile",
    async execute(toolCallId, _params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);
      const result = await api.getMe(cfg);
      if (!result.ok) return { content: [{ type: "text", text: `❌ Error: ${result.error}` }] };

      const user = result.data;
      return {
        content: [{
          type: "text",
          text: `👤 **${user.full_name_display}** (@${user.username})\n`
            + `ID: #${user.id}\n`
            + `Active: ${user.is_active ? "✅" : "❌"}`,
        }],
        details: { user },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_list_projects
  // ====================================================================
  pi.registerTool({
    name: "taiga_list_projects",
    label: "Taiga List Projects",
    description: "List all projects the authenticated user belongs to. Useful for finding projectId.",
    parameters: Type.Object({}),
    promptSnippet: "List Taiga projects the current user is a member of",
    async execute(toolCallId, _params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);
      const result = await api.listProjects(cfg);
      if (!result.ok) return { content: [{ type: "text", text: `❌ Error: ${result.error}` }] };

      const projects = result.data;
      const body = renderList(projects, formatProject);
      return {
        content: [{
          type: "text",
          text: `${projects.length} project(s):\n\n${body}`,
        }],
        details: { projects },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_get_project_by_slug
  // ====================================================================
  pi.registerTool({
    name: "taiga_get_project_by_slug",
    label: "Taiga Project By Slug",
    description: "Get a specific project by its slug. Useful for confirming projectId.",
    parameters: Type.Object({
      slug: Type.String({ description: "Project slug (e.g., 'my-project')" }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);
      const result = await api.getProjectBySlug(cfg, params.slug);
      if (!result.ok) return { content: [{ type: "text", text: `❌ Error: ${result.error}` }] };

      const p = result.data;
      return {
        content: [{
          type: "text",
          text: `📁 **${p.name}**\nSlug: \`${p.slug}\`\nID: #${p.id}\nAnonymous access: ${p.anonymous_participator ? "✅" : "❌"}\nPublic: ${p.public_visible ? "✅" : "❌"}`,
        }],
        details: { project: p },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_list_task_statuses
  // ====================================================================
  pi.registerTool({
    name: "taiga_list_task_statuses",
    label: "Taiga List Task Statuses",
    description: "List all available task statuses for a project. Use status id when creating/updating tasks.",
    parameters: Type.Object({
      projectId: Type.Number({ description: "Project ID" }),
    }),
    promptSnippet: "List task statuses for a Taiga project",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);
      const result = await api.listTaskStatuses(cfg, params.projectId);
      if (!result.ok) return { content: [{ type: "text", text: `❌ Error: ${result.error}` }] };

      const statuses = result.data;
      return {
        content: [{
          type: "text",
          text: `Task statuses for project #${params.projectId}:\n\n`
            + renderList(statuses, (s) => formatStatus(s)),
        }],
        details: { statuses },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_list_issue_statuses
  // ====================================================================
  pi.registerTool({
    name: "taiga_list_issue_statuses",
    label: "Taiga List Issue Statuses",
    description: "List all available issue statuses for a project.",
    parameters: Type.Object({
      projectId: Type.Number({ description: "Project ID" }),
    }),
    promptSnippet: "List issue statuses for a Taiga project",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);
      const result = await api.listIssueStatuses(cfg, params.projectId);
      if (!result.ok) return { content: [{ type: "text", text: `❌ Error: ${result.error}` }] };

      const statuses = result.data;
      return {
        content: [{
          type: "text",
          text: `Issue statuses for project #${params.projectId}:\n\n`
            + renderList(statuses, (s) => formatStatus(s)),
        }],
        details: { statuses },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_list_issue_types
  // ====================================================================
  pi.registerTool({
    name: "taiga_list_issue_types",
    label: "Taiga List Issue Types",
    description: "List all issue types (bug, task, etc.) for a project.",
    parameters: Type.Object({
      projectId: Type.Number({ description: "Project ID" }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);
      const result = await api.listIssueTypes(cfg, params.projectId);
      if (!result.ok) return { content: [{ type: "text", text: `❌ Error: ${result.error}` }] };

      const types = result.data;
      return {
        content: [{
          type: "text",
          text: `Issue types for project #${params.projectId}:\n\n`
            + types.map((t) => `• **[${t.color.padEnd(7)}]** ${t.name} (id=${t.id})`).join("\n"),
        }],
        details: { issueTypes: types },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_list_priorities
  // ====================================================================
  pi.registerTool({
    name: "taiga_list_priorities",
    label: "Taiga List Priorities",
    description: "List all priorities for a project.",
    parameters: Type.Object({
      projectId: Type.Number({ description: "Project ID" }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);
      const result = await api.listPriorities(cfg, params.projectId);
      if (!result.ok) return { content: [{ type: "text", text: `❌ Error: ${result.error}` }] };

      const priorities = result.data;
      return {
        content: [{
          type: "text",
          text: `Priorities for project #${params.projectId}:\n\n`
            + priorities.map((p) => `• id=${p.id} — ${p.name}`).join("\n"),
        }],
        details: { priorities },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_list_severities
  // ====================================================================
  pi.registerTool({
    name: "taiga_list_severities",
    label: "Taiga List Severities",
    description: "List all severities for a project.",
    parameters: Type.Object({
      projectId: Type.Number({ description: "Project ID" }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);
      const result = await api.listSeverities(cfg, params.projectId);
      if (!result.ok) return { content: [{ type: "text", text: `❌ Error: ${result.error}` }] };

      const severities = result.data;
      return {
        content: [{
          type: "text",
          text: `Severities for project #${params.projectId}:\n\n`
            + severities.map((s) => `• id=${s.id} — ${s.name}`).join("\n"),
        }],
        details: { severities },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_list_milestones
  // ====================================================================
  pi.registerTool({
    name: "taiga_list_milestones",
    label: "Taiga List Milestones",
    description: "List all milestones (sprints) for a project.",
    parameters: Type.Object({
      projectId: Type.Number({ description: "Project ID" }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);
      const result = await api.listMilestones(cfg, params.projectId);
      if (!result.ok) return { content: [{ type: "text", text: `❌ Error: ${result.error}` }] };

      const milestones = result.data;
      return {
        content: [{
          type: "text",
          text: `Milestones for project #${params.projectId}:\n\n`
            + milestones.map((m) => {
              const dates = [m.start_date, m.finish_date].filter(Boolean).join(" → ");
              return `• **#${m.id}** ${m.name}${dates ? ` (${dates})` : ""}`;
            }).join("\n"),
        }],
        details: { milestones },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_list_tasks
  // ====================================================================
  pi.registerTool({
    name: "taiga_list_tasks",
    label: "Taiga List Tasks",
    description: "List tasks in a project with optional filters. Use this to find tasks by status, assignee, milestone, etc.",
    parameters: Type.Object({
      projectId: Type.Number({ description: "Project ID" }),
      statusId: Type.Optional(Type.Number({ description: "Filter by task status ID" })),
      assignedTo: Type.Optional(Type.Number({ description: "Filter by assignee user ID" })),
      milestoneId: Type.Optional(Type.Number({ description: "Filter by milestone/sprint ID" })),
      isClosed: Type.Optional(Type.Boolean({ description: "Filter by closed status (true=open, false=closed)" })),
      tags: Type.Optional(Type.String({ description: "Comma-separated tag filter" })),
    }),
    promptSnippet: "List and filter tasks in a Taiga project",
    promptGuidelines: [
      "Use taiga_list_tasks to find existing tasks before creating new ones.",
      "Use taiga_list_task_statuses first to get valid status IDs.",
    ],
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);
      const filters: Record<string, unknown> = { project: params.projectId };
      if (params.statusId) filters.status = params.statusId;
      if (params.assignedTo !== undefined) filters.assigned_to = params.assignedTo;
      if (params.milestoneId) filters.milestone = params.milestoneId;
      if (params.isClosed !== undefined) filters["status__is_closed"] = params.isClosed;
      if (params.tags) filters.tags = params.tags.split(",").map((t) => t.trim());

      const result = await api.listTasks(cfg, filters as any);
      if (!result.ok) return { content: [{ type: "text", text: `❌ Error: ${result.error}` }] };

      const tasks = result.data;
      const body = tasks.length > 0 ? tasks.map(taskRow).join("\n") : "_No tasks found._";
      return {
        content: [{
          type: "text",
          text: `${tasks.length} task(s) in project #${params.projectId}:\n\n${body}`,
        }],
        details: { tasks },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_get_task
  // ====================================================================
  pi.registerTool({
    name: "taiga_get_task",
    label: "Taiga Get Task",
    description: "Get details of a specific task by ID.",
    parameters: Type.Object({
      taskId: Type.Number({ description: "Task ID" }),
    }),
    promptSnippet: "Get full details of a single Taiga task",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);
      const result = await api.getTask(cfg, params.taskId);
      if (!result.ok) return { content: [{ type: "text", text: `❌ Error: ${result.error}` }] };

      const task = result.data;
      const assignee = task.assigned_to_extra_info
        ? `${task.assigned_to_extra_info.full_name_display} (@${task.assigned_to_extra_info.username})`
        : "unassigned";
      const status = task.status_extra_info;
      return {
        content: [{
          type: "text",
          text: [
            `**#${task.ref}**: ${task.subject}`,
            `Status: [${status?.color}] ${status?.name || "?"}${status?.is_closed ? " (closed)" : ""}`,
            `Assignee: ${assignee}`,
            `Project: #${task.project} (${task.project_extra_info?.name || "unknown"})`,
            `Milestone: ${task.milestone_slug || "none"}`,
            `Description:\n  ${task.description || "(empty)"}`,
            `Tags: ${(task.tags || []).map((t) => t[0]).join(", ") || "(none)"}`,
            `Created: ${task.created_date}`,
            `Modified: ${task.modified_date}`,
            `Comments: ${task.total_comments} | Voters: ${task.total_voters} | Watchers: ${task.total_watchers}`,
          ].join("\n"),
        }],
        details: { task },
      };
    },
  });

  // ====================================================================
  // Helper: confirmation gate for write operations
  // ====================================================================
  async function confirmWrite(
    ctx: any,
    action: string,
    objectInfo: string,
    description?: string,
  ): Promise<boolean> {
    const msg = description
      ? `Are you sure you want to ${action.toLowerCase()} this ${objectInfo}?\n\n${description}`
      : `Are you sure you want to ${action.toLowerCase()} this ${objectInfo}? This will modify data in your Taiga instance.`;
    const confirmed = await ctx.ui.confirm(
      `Confirm ${action} on Taiga`,
      msg,
    );
    if (!confirmed) {
      return false;
    }
    return true;
  }

  // ====================================================================
  // Tool: taiga_create_task
  // ====================================================================
  pi.registerTool({
    name: "taiga_create_task",
    label: "Taiga Create Task",
    description: "Create a new task in a Taiga project. Requires confirmation.",
    parameters: Type.Object({
      projectId: Type.Number({ description: "Project ID" }),
      subject: Type.String({ description: "Task title/summary" }),
      description: Type.Optional(Type.String({ description: "Task description (markdown supported)" })),
      statusId: Type.Optional(Type.Number({ description: "Status ID (default: first active status)" })),
      milestoneId: Type.Optional(Type.Number({ description: "Milestone/sprint ID to assign" })),
      assignedTo: Type.Optional(Type.Number({ description: "User ID to assign the task to" })),
      userStoryId: Type.Optional(Type.Number({ description: "Related user story ID" })),
      tags: Type.Optional(Type.String({ description: "Comma-separated list of tags" })),
    }),
    promptSnippet: "Create a new Taiga task in a project (requires confirmation)",
    promptGuidelines: [
      "Use taiga_create_task when you need to create work items.",
      "This tool will prompt for confirmation before creating the task.",
      "Pass statusId from taiga_list_task_statuses; pass milestoneId from taiga_list_milestones.",
    ],
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);

      // Confirm before creating
      const confirmed = await confirmWrite(
        ctx,
        "create a task",
        `#${params.projectId}`
      );
      if (!confirmed) return { content: [{ type: "text", text: "❌ Task creation cancelled by user." }] };

      const body: Record<string, unknown> = {
        project: params.projectId,
        subject: params.subject,
      };
      if (params.description) body.description = params.description;
      if (params.statusId) body.status = params.statusId;
      if (params.milestoneId !== undefined) body.milestone = params.milestoneId;
      if (params.assignedTo !== undefined) body.assigned_to = params.assignedTo;
      if (params.userStoryId) body.user_story = params.userStoryId;
      if (params.tags) body.tags = params.tags.split(",").map((t) => t.trim());

      const result = await api.createTask(cfg, body);
      if (!result.ok) return { content: [{ type: "text", text: `❌ Error creating task: ${result.error}` }] };

      const task = result.data;
      return {
        content: [{
          type: "text",
          text: `✅ **Task created!**\n`
            + `**#${task.ref}**: ${task.subject}\n`
            + `ID: #${task.id}\n`
            + `Status: ${task.status_extra_info?.name}\n`
            + `Project: #${task.project}\n`
            + (task.assigned_to_extra_info ? `Assigned to: ${task.assigned_to_extra_info.full_name_display}` : "Unassigned"),
        }],
        details: { task },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_update_task
  // ====================================================================
  pi.registerTool({
    name: "taiga_update_task",
    label: "Taiga Update Task",
    description: "Update a task. Only provide the fields you want to change (PATCH request).",
    parameters: Type.Object({
      taskId: Type.Number({ description: "Task ID" }),
      subject: Type.Optional(Type.String({ description: "New title" })),
      description: Type.Optional(Type.String({ description: "New description" })),
      statusId: Type.Optional(Type.Number({ description: "New status ID" })),
      milestoneId: Type.Optional(Type.Number(), { description: "Milestone ID, or null to remove" }),
      assignedTo: Type.Optional(Type.Number(), { description: "User ID to assign, or null to unassign" }),
      isClosed: Type.Optional(Type.Boolean({ description: "Set task as closed or open" })),
      isBlocked: Type.Optional(Type.Boolean({ description: "Mark as blocked" })),
      blockedNote: Type.Optional(Type.String({ description: "Reason why task is blocked" })),
      userStoryId: Type.Optional(Type.Number(), { description: "Related user story ID, or null to remove" }),
      tags: Type.Optional(Type.String({ description: "Comma-separated tags" })),
    }),
    promptSnippet: "Update a Taiga task (partial patch)",
    promptGuidelines: [
      "Use taiga_update_task to change task status, assignee, or other fields.",
      "Only include fields you want to update; unchanged fields are left as-is.",
    ],
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);

      // Confirm before updating task status/assignee/etc.
      const changedFields = Object.keys(params).filter(k => k !== "taskId");
      const confirmMsg = `Task ID: ${params.taskId}\nChanged fields: ${changedFields.join(", ")}`;
      const confirmed = await confirmWrite(
        ctx,
        "update task",
        `#${params.taskId}`,
        confirmMsg,
      );
      if (!confirmed) return { content: [{ type: "text", text: "❌ Task update cancelled by user." }] };

      const fields: Record<string, unknown> = {};
      if (params.subject !== undefined) fields.subject = params.subject;
      if (params.description !== undefined) fields.description = params.description;
      if (params.statusId !== undefined) fields.status = params.statusId;
      if (params.milestoneId !== undefined) fields.milestone = params.milestoneId ?? null;
      if (params.assignedTo !== undefined) fields.assigned_to = params.assignedTo ?? null;
      if (params.isClosed !== undefined) fields.is_closed = params.isClosed;
      if (params.isBlocked !== undefined) fields.is_blocked = params.isBlocked;
      if (params.blockedNote !== undefined) fields.blocked_note = params.blockedNote;
      if (params.userStoryId !== undefined) fields.user_story = params.userStoryId ?? null;
      if (params.tags !== undefined) fields.tags = params.tags.split(",").map((t) => t.trim());

      const result = await api.updateTask(cfg, params.taskId, fields);
      if (!result.ok) return { content: [{ type: "text", text: `❌ Error updating task: ${result.error}` }] };

      const task = result.data;
      return {
        content: [{
          type: "text",
          text: `✅ **Task updated!**\n`
            + `**#${task.ref}**: ${task.subject}\n`
            + `Status: ${task.status_extra_info?.name}\n`
            + (task.assigned_to_extra_info ? `Assignee: ${task.assigned_to_extra_info.full_name_display}` : "Unassigned"),
        }],
        details: { task },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_delete_task
  // ====================================================================
  pi.registerTool({
    name: "taiga_delete_task",
    label: "Taiga Delete Task",
    description: "Delete a task. This is permanent and requires confirmation.",
    parameters: Type.Object({
      taskId: Type.Number({ description: "Task ID to delete" }),
    }),
    promptSnippet: "Delete a Taiga task permanently (requires confirmation)",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);

      // First get the task name for confirmation display
      const getResult = await api.getTask(cfg, params.taskId);
      if (!getResult.ok) return { content: [{ type: "text", text: `❌ Error: Task not found — ${getResult.error}` }] };

      const confirmMsg = `${params.taskId}\nSubject: ${getResult.data.subject}`;
      const confirmed = await confirmWrite(
        ctx,
        "delete",
        `Task #${params.taskId}`,
        confirmMsg,
      );
      if (!confirmed) return { content: [{ type: "text", text: "❌ Task deletion cancelled by user." }] };

      const deleteResult = await api.deleteTask(cfg, params.taskId);
      if (!deleteResult.ok) return { content: [{ type: "text", text: `❌ Error deleting task: ${deleteResult.error}` }] };

      return {
        content: [{
          type: "text",
          text: `✅ **Task deleted!**\n**#${getResult.data.ref}**: ${getResult.data.subject}`,
        }],
        details: { taskId: params.taskId },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_list_issues
  // ====================================================================
  pi.registerTool({
    name: "taiga_list_issues",
    label: "Taiga List Issues",
    description: "List issues in a project with optional filters.",
    parameters: Type.Object({
      projectId: Type.Number({ description: "Project ID" }),
      statusId: Type.Optional(Type.Number({ description: "Filter by issue status ID" })),
      typeId: Type.Optional(Type.Number({ description: "Filter by issue type ID" })),
      priorityId: Type.Optional(Type.Number({ description: "Filter by priority ID" })),
      severityId: Type.Optional(Type.Number({ description: "Filter by severity ID" })),
      assignedTo: Type.Optional(Type.Number({ description: "Filter by assignee user ID" })),
      isClosed: Type.Optional(Type.Boolean({ description: "true=open, false=closed" })),
    }),
    promptSnippet: "List and filter issues in a Taiga project",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);
      const filters: Record<string, unknown> = { project: params.projectId };
      if (params.statusId) filters.status = params.statusId;
      if (params.typeId) filters.type = params.typeId;
      if (params.priorityId) filters.priority = params.priorityId;
      if (params.severityId) filters.severity = params.severityId;
      if (params.assignedTo !== undefined) filters.assigned_to = params.assignedTo;
      if (params.isClosed !== undefined) filters["status__is_closed"] = params.isClosed;

      const result = await api.listIssues(cfg, filters as any);
      if (!result.ok) return { content: [{ type: "text", text: `❌ Error: ${result.error}` }] };

      const issues = result.data;
      const body = issues.length > 0 ? issues.map(issueRow).join("\n") : "_No issues found._";
      return {
        content: [{
          type: "text",
          text: `${issues.length} issue(s) in project #${params.projectId}:\n\n${body}`,
        }],
        details: { issues },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_get_issue
  // ====================================================================
  pi.registerTool({
    name: "taiga_get_issue",
    label: "Taiga Get Issue",
    description: "Get details of a specific issue by ID.",
    parameters: Type.Object({
      issueId: Type.Number({ description: "Issue ID" }),
    }),
    promptSnippet: "Get full details of a single Taiga issue",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);
      const result = await api.getIssue(cfg, params.issueId);
      if (!result.ok) return { content: [{ type: "text", text: `❌ Error: ${result.error}` }] };

      const issue = result.data;
      const assignee = issue.assigned_to_extra_info
        ? `${issue.assigned_to_extra_info.full_name_display} (@${issue.assigned_to_extra_info.username})`
        : "unassigned";
      const status = issue.status_extra_info;
      return {
        content: [{
          type: "text",
          text: [
            `**#${issue.ref}**: ${issue.subject}`,
            `Status: [${status?.color}] ${status?.name || "?"}${status?.is_closed ? " (closed)" : ""}`,
            `Type: ${issue.issue_type_extra_info?.name || "?"} | Priority: ${issue.priority_extra_info?.name || "?"} | Severity: ${issue.severity_extra_info?.name || "?"}`,
            `Assignee: ${assignee}`,
            `Project: #${issue.project} (${issue.project_extra_info?.name || "unknown"})`,
            `Description:\n  ${issue.description || "(empty)"}`,
            `Tags: ${(issue.tags || []).map((t) => t[0]).join(", ") || "(none)"}`,
          ].join("\n"),
        }],
        details: { issue },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_create_issue
  // ====================================================================
  pi.registerTool({
    name: "taiga_create_issue",
    label: "Taiga Create Issue",
    description: "Create a new issue in a Taiga project. Requires confirmation.",
    parameters: Type.Object({
      projectId: Type.Number({ description: "Project ID" }),
      subject: Type.String({ description: "Issue title/summary" }),
      description: Type.Optional(Type.String({ description: "Issue description" })),
      statusId: Type.Optional(Type.Number({ description: "Status ID" })),
      typeId: Type.Optional(Type.Number({ description: "Issue type ID (bug, task, etc.)" })),
      priorityId: Type.Optional(Type.Number({ description: "Priority ID" })),
      severityId: Type.Optional(Type.Number({ description: "Severity ID" })),
      milestoneId: Type.Optional(Type.Number({ description: "Milestone/sprint ID" })),
      assignedTo: Type.Optional(Type.Number({ description: "User ID to assign" })),
      tags: Type.Optional(Type.String({ description: "Comma-separated tags" })),
    }),
    promptSnippet: "Create a new Taiga issue (requires confirmation)",
    promptGuidelines: [
      "Use taiga_create_issue when reporting bugs or creating issues.",
      "This tool will prompt for confirmation before creating the issue.",
      "Check taiga_list_issue_types and taiga_list_priorities for valid IDs.",
    ],
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);

      // Confirm before creating issue
      const confirmMsg = `Project: ${params.projectId}\nSubject: ${params.subject}`;
      const confirmed = await confirmWrite(
        ctx,
        "create an issue",
        `#${params.projectId}`,
        confirmMsg,
      );
      if (!confirmed) return { content: [{ type: "text", text: "❌ Issue creation cancelled by user." }] };

      const body: Record<string, unknown> = {
        project: params.projectId,
        subject: params.subject,
      };
      if (params.description) body.description = params.description;
      if (params.statusId) body.status = params.statusId;
      if (params.typeId) body.type = params.typeId;
      if (params.priorityId) body.priority = params.priorityId;
      if (params.severityId) body.severity = params.severityId;
      if (params.milestoneId !== undefined) body.milestone = params.milestoneId;
      if (params.assignedTo !== undefined) body.assigned_to = params.assignedTo;
      if (params.tags) body.tags = params.tags.split(",").map((t) => t.trim());

      const result = await api.createIssue(cfg, body);
      if (!result.ok) return { content: [{ type: "text", text: `❌ Error creating issue: ${result.error}` }] };

      const issue = result.data;
      return {
        content: [{
          type: "text",
          text: `✅ **Issue created!**\n`
            + `**#${issue.ref}**: ${issue.subject}\n`
            + `ID: #${issue.id}\n`
            + `Type: ${issue.issue_type_extra_info?.name || "?"}\n`
            + `Priority: ${issue.priority_extra_info?.name || "?"}`,
        }],
        details: { issue },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_update_issue
  // ====================================================================
  pi.registerTool({
    name: "taiga_update_issue",
    label: "Taiga Update Issue",
    description: "Update an issue (PATCH). Only provide fields to change. Requires confirmation.",
    parameters: Type.Object({
      issueId: Type.Number({ description: "Issue ID" }),
      subject: Type.Optional(Type.String({ description: "New title" })),
      description: Type.Optional(Type.String({ description: "New description" })),
      statusId: Type.Optional(Type.Number({ description: "New status ID" })),
      typeId: Type.Optional(Type.Number({ description: "New issue type ID" })),
      priorityId: Type.Optional(Type.Number({ description: "New priority ID" })),
      severityId: Type.Optional(Type.Number({ description: "New severity ID" })),
      milestoneId: Type.Optional(Type.Union([Type.Number(), Type.Null()]), { description: "Milestone ID or null to remove" }),
      assignedTo: Type.Optional(Type.Union([Type.Number(), Type.Null()]), { description: "User ID to assign, or null to unassign" }),
      isClosed: Type.Optional(Type.Boolean({ description: "Close or reopen the issue" })),
    }),
    promptSnippet: "Update a Taiga issue (partial patch, requires confirmation)",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);

      // Confirm before updating issue
      const changedFields = Object.keys(params).filter(k => k !== "issueId");
      const confirmMsg = `Issue ID: ${params.issueId}\nChanged fields: ${changedFields.join(", ")}`;
      const confirmed = await confirmWrite(
        ctx,
        "update issue",
        `#${params.issueId}`,
        confirmMsg,
      );
      if (!confirmed) return { content: [{ type: "text", text: "❌ Issue update cancelled by user." }] };

      const fields: Record<string, unknown> = {};
      if (params.subject !== undefined) fields.subject = params.subject;
      if (params.description !== undefined) fields.description = params.description;
      if (params.statusId !== undefined) fields.status = params.statusId;
      if (params.typeId !== undefined) fields.type = params.typeId;
      if (params.priorityId !== undefined) fields.priority = params.priorityId;
      if (params.severityId !== undefined) fields.severity = params.severityId;
      if (params.milestoneId !== undefined) fields.milestone = params.milestoneId ?? null;
      if (params.assignedTo !== undefined) fields.assigned_to = params.assignedTo ?? null;
      if (params.isClosed !== undefined) fields.is_closed = params.isClosed;

      const result = await api.updateIssue(cfg, params.issueId, fields);
      if (!result.ok) return { content: [{ type: "text", text: `❌ Error updating issue: ${result.error}` }] };

      const issue = result.data;
      return {
        content: [{
          type: "text",
          text: `✅ **Issue updated!**\n`
            + `**#${issue.ref}**: ${issue.subject}\n`
            + `Status: ${issue.status_extra_info?.name}`,
        }],
        details: { issue },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_delete_issue
  // ====================================================================
  pi.registerTool({
    name: "taiga_delete_issue",
    label: "Taiga Delete Issue",
    description: "Delete an issue permanently. Requires confirmation.",
    parameters: Type.Object({
      issueId: Type.Number({ description: "Issue ID to delete" }),
    }),
    promptSnippet: "Delete a Taiga issue permanently (requires confirmation)",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);

      // First get the issue name for confirmation display
      const getResult = await api.getIssue(cfg, params.issueId);
      if (!getResult.ok) return { content: [{ type: "text", text: `❌ Error: Issue not found — ${getResult.error}` }] };

      const confirmMsg = `${params.issueId}\nSubject: ${getResult.data.subject}`;
      const confirmed = await confirmWrite(
        ctx,
        "delete",
        `Issue #${params.issueId}`,
        confirmMsg,
      );
      if (!confirmed) return { content: [{ type: "text", text: "❌ Issue deletion cancelled by user." }] };

      const deleteResult = await api.deleteIssue(cfg, params.issueId);
      if (!deleteResult.ok) return { content: [{ type: "text", text: `❌ Error deleting issue: ${deleteResult.error}` }] };

      return {
        content: [{
          type: "text",
          text: `✅ **Issue deleted!**\n**#${getResult.data.ref}**: ${getResult.data.subject}`,
        }],
        details: { issueId: params.issueId },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_add_comment
  // ====================================================================
  pi.registerTool({
    name: "taiga_add_comment",
    label: "Taiga Add Comment",
    description: "Add a comment to a task or issue via history. Supports private comments. Requires confirmation.",
    parameters: Type.Object({
      taskId: Type.Optional(Type.Number({ description: "Task ID (mutually exclusive with issueId)" })),
      issueId: Type.Optional(Type.Number({ description: "Issue ID (mutually exclusive with taskId)" })),
      comment: Type.String({ description: "Comment text (markdown supported)" }),
      isPrivate: Type.Optional(Type.Boolean({ description: "Make comment private? Default: false" })),
    }),
    promptSnippet: "Add a comment to a Taiga task or issue (requires confirmation)",
    promptGuidelines: [
      "Use taiga_add_comment to leave notes on tasks/issues.",
      "This tool will prompt for confirmation before adding the comment.",
      "Set isPrivate=true if the comment should only be visible to team members.",
    ],
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);

      const hasTask = params.taskId !== undefined;
      const hasIssue = params.issueId !== undefined;
      if (!hasTask && !hasIssue) return { content: [{ type: "text", text: "❌ Provide either taskId or issueId." }] };
      if (hasTask && hasIssue) return { content: [{ type: "text", text: "❌ Use either taskId or issueId, not both." }] };

      // Confirm before adding comment
      const objType = hasTask ? "task" : "issue";
      const objId = hasTask ? params.taskId! : params.issueId!;
      const confirmMsg = `${objType.toUpperCase()} ID: ${objId}\nComment: "${params.comment}"`;
      const confirmed = await confirmWrite(
        ctx,
        "add a comment",
        `${objType} #${objId}`,
        confirmMsg,
      );
      if (!confirmed) return { content: [{ type: "text", text: "❌ Comment addition cancelled by user." }] };

      let targetObj: TaigaTask | TaigaIssue;
      const fields: Record<string, unknown> = { comment: params.comment };

      if (hasTask) {
        // PATCH the task with the comment field — Taiga API accepts this for adding comments
        const getResult = await api.getTask(cfg, params.taskId!);
        if (!getResult.ok) return { content: [{ type: "text", text: `❌ Task not found: ${getResult.error}` }] };
        targetObj = getResult.data;

        // The Taiga API for adding comments to tasks/issues uses PATCH with comment field
        const updateResult = await api.updateTask(cfg, params.taskId!, fields);
        if (!updateResult.ok) {
          // Fallback: try PATCH directly on the history endpoint
          const result = await api.getTaskHistory(cfg, params.taskId!);
          return { content: [{ type: "text", text: `❌ Error adding comment: ${updateResult.error}` }] };
        }
      } else {
        // For issues, PATCH with comment field
        const getResult = await api.getIssue(cfg, params.issueId!);
        if (!getResult.ok) return { content: [{ type: "text", text: `❌ Issue not found: ${getResult.error}` }] };
        targetObj = getResult.data;

        const updateResult = await api.updateIssue(cfg, params.issueId!, fields);
        if (!updateResult.ok) {
          return { content: [{ type: "text", text: `❌ Error adding comment: ${updateResult.error}` }] };
        }
      }

      // Re-fetch to get updated object with new total_comments count
      const reFetch = hasTask
        ? await api.getTask(cfg, params.taskId!)
        : await api.getIssue(cfg, params.issueId!);

      if (reFetch.ok && reFetch.data) {
        return {
          content: [{
            type: "text",
            text: `✅ Comment added.\nComment: "${params.comment}"\nPrivate: ${params.isPrivate ? "yes" : "no"}\nTotal comments: ${(reFetch.data as any).total_comments || "?"}`,
          }],
          details: { comment: params.comment, isPrivate: params.isPrivate },
        };
      }

      return {
        content: [{ type: "text", text: `✅ Comment added.\n"${params.comment}"` }],
        details: { comment: params.comment, isPrivate: params.isPrivate },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_get_task_history
  // ====================================================================
  pi.registerTool({
    name: "taiga_get_task_history",
    label: "Taiga Get Task History",
    description: "Get the comment history for a task.",
    parameters: Type.Object({
      taskId: Type.Number({ description: "Task ID" }),
    }),
    promptSnippet: "View comment history of a Taiga task",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);
      const result = await api.getTaskHistory(cfg, params.taskId);
      if (!result.ok) return { content: [{ type: "text", text: `❌ Error: ${result.error}` }] };

      const entries = result.data;
      const comments = entries.filter((e) => e.comment);
      if (!comments.length) return { content: [{ type: "text", text: "_No comments on this task._" }] };

      const lines = comments.map((e) => {
        const user = e.user_extra_info ? `${e.user_extra_info.full_name_display} (@${e.user_extra_info.username})` : "unknown";
        return `• **${user}** — ${e.created_date}\n  > ${(e.comment || "").substring(0, 500)}${(e.comment || "").length > 500 ? "..." : ""}`;
      });

      return {
        content: [{
          type: "text",
          text: `History for task #${params.taskId}:\n\n${lines.join("\n\n")}`,
        }],
        details: { entries },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_get_issue_history
  // ====================================================================
  pi.registerTool({
    name: "taiga_get_issue_history",
    label: "Taiga Get Issue History",
    description: "Get the comment history for an issue.",
    parameters: Type.Object({
      issueId: Type.Number({ description: "Issue ID" }),
    }),
    promptSnippet: "View comment history of a Taiga issue",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);
      const result = await api.getIssueHistory(cfg, params.issueId);
      if (!result.ok) return { content: [{ type: "text", text: `❌ Error: ${result.error}` }] };

      const entries = result.data;
      const comments = entries.filter((e) => e.comment);
      if (!comments.length) return { content: [{ type: "text", text: "_No comments on this issue._" }] };

      const lines = comments.map((e) => {
        const user = e.user_extra_info ? `${e.user_extra_info.full_name_display} (@${e.user_extra_info.username})` : "unknown";
        return `• **${user}** — ${e.created_date}\n  > ${(e.comment || "").substring(0, 500)}${(e.comment || "").length > 500 ? "..." : ""}`;
      });

      return {
        content: [{
          type: "text",
          text: `History for issue #${params.issueId}:\n\n${lines.join("\n\n")}`,
        }],
        details: { entries },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_watch_task / taiga_unwatch_task (combined via action param)
  // ====================================================================
  pi.registerTool({
    name: "taiga_toggle_task_watch",
    label: "Taiga Toggle Task Watch",
    description: "Watch or unwatch a task to receive notifications about changes.",
    parameters: Type.Object({
      taskId: Type.Number({ description: "Task ID" }),
      action: StringEnum(["watch", "unwatch"] as const),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);

      let result;
      if (params.action === "watch") {
        result = await api.watchTask(cfg, params.taskId);
      } else {
        result = await api.unwatchTask(cfg, params.taskId);
      }

      if (!result.ok) return { content: [{ type: "text", text: `❌ Error: ${result.error}` }] };

      const action = params.action === "watch" ? "🔔 Watching" : "🔕 Unwatching";
      return {
        content: [{ type: "text", text: `${action} task #${params.taskId}` }],
        details: { taskId: params.taskId, action: params.action },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_search
  // ====================================================================
  pi.registerTool({
    name: "taiga_search",
    label: "Taiga Search",
    description: "Search across tasks, issues, epics and other objects in Taiga.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query text" }),
      projectId: Type.Optional(Type.Number({ description: "Limit search to a specific project" })),
    }),
    promptSnippet: "Search across Taiga tasks, issues, epics, etc.",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);

      const filterParams = params.projectId ? { project: params.projectId } : undefined;
      const result = await api.search(cfg, params.query, filterParams);
      if (!result.ok) return { content: [{ type: "text", text: `❌ Error: ${result.error}` }] };

      const results = result.data;
      if (!results.length) return { content: [{ type: "text", text: "_No results found._" }] };

      // Display as simple list — Taiga search returns mixed object types
      const lines = results.map((r: Record<string, unknown>, i: number) => {
        const objectType = (r.object_type as string) || "unknown";
        const subject = (r.subject as string) || "(no subject)";
        const projectSlug = ((r.project_extra_info as any)?.slug) || ((r as any).project_slug) || "?";
        return `${i + 1}. **[${objectType}]** #${subject} — Project: ${projectSlug}`;
      });

      return {
        content: [{
          type: "text",
          text: `Search "${params.query}" → ${results.length} result(s):\n\n${lines.join("\n")}`,
        }],
        details: { results, query: params.query },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_assign_to_self
  // ====================================================================
  pi.registerTool({
    name: "taiga_assign_to_self",
    label: "Taiga Assign To Self",
    description: "Quickly assign a task or issue to the currently logged-in user.",
    parameters: Type.Object({
      taskId: Type.Optional(Type.Number({ description: "Task ID" })),
      issueId: Type.Optional(Type.Number({ description: "Issue ID" })),
    }),
    promptSnippet: "Assign a task or issue to yourself",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);

      // Get current user
      const meResult = await api.getMe(cfg);
      if (!meResult.ok) return { content: [{ type: "text", text: `❌ Cannot get current user: ${meResult.error}` }] };
      const myId = meResult.data.id;

      if (params.taskId !== undefined) {
        const result = await api.updateTask(cfg, params.taskId, { assigned_to: myId });
        if (!result.ok) return { content: [{ type: "text", text: `❌ Error assigning task: ${result.error}` }] };

        return {
          content: [{
            type: "text",
            text: `✅ Task **#${result.data.ref}** assigned to you (${meResult.data.full_name_display}).`,
          }],
          details: { taskId: params.taskId, assignedTo: myId },
        };
      }

      if (params.issueId !== undefined) {
        const result = await api.updateIssue(cfg, params.issueId, { assigned_to: myId });
        if (!result.ok) return { content: [{ type: "text", text: `❌ Error assigning issue: ${result.error}` }] };

        return {
          content: [{
            type: "text",
            text: `✅ Issue **#${result.data.ref}** assigned to you (${meResult.data.full_name_display}).`,
          }],
          details: { issueId: params.issueId, assignedTo: myId },
        };
      }

      return { content: [{ type: "text", text: "❌ Provide either taskId or issueId." }] };
    },
  });

  // ====================================================================
  // Tool: taiga_list_users
  // ====================================================================
  pi.registerTool({
    name: "taiga_list_users",
    label: "Taiga List Users",
    description: "List users (optionally filtered by project) to find user IDs for assignment.",
    parameters: Type.Object({
      projectId: Type.Optional(Type.Number({ description: "Filter users in a specific project" })),
    }),
    promptSnippet: "List Taiga users for finding assignee IDs",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);

      let result;
      if (params.projectId) {
        // Users are returned as part of project detail; fetch memberships or use general list
        result = await api.listUsers(cfg);
      } else {
        result = await api.listUsers(cfg);
      }

      if (!result.ok) return { content: [{ type: "text", text: `❌ Error: ${result.error}` }] };

      const users = result.data;
      return {
        content: [{
          type: "text",
          text: `${users.length} user(s):\n\n` + renderList(users, (u) => formatUser(u)),
        }],
        details: { users },
      };
    },
  });

  // ====================================================================
  // Tool: taiga_update_status
  // ====================================================================
  pi.registerTool({
    name: "taiga_update_status",
    label: "Taiga Update Status",
    description: "Quickly update the status of a task or issue. Use with taiga_list_task_statuses or taiga_list_issue_statuses first.",
    parameters: Type.Object({
      taskId: Type.Optional(Type.Number({ description: "Task ID" })),
      issueId: Type.Optional(Type.Number({ description: "Issue ID" })),
      statusId: Type.Number({ description: "Target status ID" }),
    }),
    promptSnippet: "Update the status of a Taiga task or issue",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = await ensureAuth(authStore, ctx, authStore);

      const hasTask = params.taskId !== undefined;
      const hasIssue = params.issueId !== undefined;
      if (!hasTask && !hasIssue) return { content: [{ type: "text", text: "❌ Provide either taskId or issueId." }] };

      let result;
      if (hasTask) {
        result = await api.updateTask(cfg, params.taskId!, { status: params.statusId });
      } else {
        result = await api.updateIssue(cfg, params.issueId!, { status: params.statusId });
      }

      if (!result.ok) return { content: [{ type: "text", text: `❌ Error updating status: ${result.error}` }] };

      const objType = hasTask ? "Task" : "Issue";
      const statusName = (result.data as any).status_extra_info?.name || "?";
      return {
        content: [{ type: "text", text: `✅ ${objType} **#${(result.data as any).ref}** status → **${statusName}**` }],
        details: { taskId: params.taskId, issueId: params.issueId, statusId: params.statusId },
      };
    },
  });
}
