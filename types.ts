// ============================================================================
// Types for Taiga REST API objects (relevant subset for our tools)
// ============================================================================

/** User object returned by Taiga */
export interface TaigaUser {
  id: number;
  username: string;
  full_name_display: string;
  email?: string;
  is_active: boolean;
  photo?: string | null;
  big_photo?: string | null;
}

/** Project object returned by Taiga */
export interface TaigaProject {
  id: number;
  slug: string;
  name: string;
  logo_small_url?: string | null;
  description?: string;
  anonymous_participator: boolean;
  public_visible: boolean;
}

/** Status object (task or issue) */
export interface TaigaStatus {
  id: number;
  name: string;
  color: string;
  is_closed: boolean;
  order: number;
}

/** Issue type */
export interface TaigaIssueType {
  id: number;
  name: string;
  color: string;
}

/** Priority object */
export interface TaigaPriority {
  id: number;
  name: string;
  order: number;
}

/** Severity object */
export interface TaigaSeverity {
  id: number;
  name: string;
  order: number;
}

/** Milestone / Sprint */
export interface TaigaMilestone {
  id: number;
  name: string;
  slug: string;
  project?: number;
  start_date?: string;
  finish_date?: string;
  is_active: boolean;
}

/** Watcher object */
export interface TaigaWatcher {
  id: number;
  full_name_display: string;
  username: string;
}

// -------------------------------------------------------------------------
// Task / Issue base fields
// -------------------------------------------------------------------------

export interface AssignedToExtraInfo {
  id: number;
  username: string;
  full_name_display: string;
  is_active: boolean;
  photo?: string | null;
  big_photo?: string | null;
}

export interface ProjectExtraInfo {
  id: number;
  slug: string;
  name: string;
  logo_small_url?: string | null;
}

// -------------------------------------------------------------------------
// Task-specific types
// -------------------------------------------------------------------------

export interface TaigaTask {
  id: number;
  ref: number;
  subject: string;
  description: string;
  description_html: string;
  project: number;
  project_extra_info: ProjectExtraInfo;
  status: number;
  status_extra_info: StatusExtraInfo;
  task_status_name: string;
  is_closed: boolean;
  milestone?: number | null;
  milestone_slug?: string | null;
  assigned_to?: number | null;
  assigned_to_extra_info?: AssignedToExtraInfo | null;
  owner: number;
  total_comments: number;
  total_voters: number;
  total_watchers: number;
  is_watcher: boolean;
  is_voter: boolean;
  is_blocked: boolean;
  blocked_note: string;
  user_story?: number | null;
  us_order: number;
  taskboard_order: number;
  tags: Array<[string, string]>;
  created_date: string;
  modified_date: string;
  finished_date?: string | null;
  due_date?: string | null;
  version?: number;
}

/** Fields you can PATCH on a task */
export interface TaskPatchFields {
  subject?: string;
  description?: string;
  status?: number;           // status id
  milestone?: number | null;
  assigned_to?: number | null;
  is_closed?: boolean;
  is_blocked?: boolean;
  blocked_note?: string;
  user_story?: number | null;
  us_order?: number;
  taskboard_order?: number;
  tags?: string[];
  watchers?: number[];
}

/** Fields you can POST when creating a task */
export interface TaskCreateFields {
  subject: string;
  project: number;
  description?: string;
  status?: number;
  milestone?: number | null;
  assigned_to?: number | null;
  user_story?: number | null;
  tags?: string[];
}

// -------------------------------------------------------------------------
// Issue-specific types
// -------------------------------------------------------------------------

export interface StatusExtraInfo {
  id: number;
  name: string;
  color: string;
  is_closed: boolean;
}

export interface TaigaIssue {
  id: number;
  ref: number;
  subject: string;
  description: string;
  project: number;
  project_extra_info: ProjectExtraInfo;
  status: number;
  status_extra_info: StatusExtraInfo;
  issue_status_name: string;
  is_closed: boolean;
  milestone?: number | null;
  milestone_slug?: string | null;
  assigned_to?: number | null;
  assigned_to_extra_info?: AssignedToExtraInfo | null;
  issue_type: number;
  issue_type_extra_info: { id: number; name: string; color: string };
  priority: number;
  priority_extra_info: { id: number; name: string; order: number };
  severity: number;
  severity_extra_info: { id: number; name: string; order: number };
  tags: Array<[string, string]>;
  created_date: string;
  modified_date: string;
  total_comments: number;
  is_watcher: boolean;
}

/** Fields you can PATCH on an issue */
export interface IssuePatchFields {
  subject?: string;
  description?: string;
  status?: number;
  milestone?: number | null;
  assigned_to?: number | null;
  is_closed?: boolean;
  issue_type?: number;
  priority?: number;
  severity?: number;
  tags?: string[];
  watchers?: number[];
}

/** Fields you can POST when creating an issue */
export interface IssueCreateFields {
  subject: string;
  project: number;
  description?: string;
  status?: number;
  issue_type?: number;
  priority?: number;
  severity?: number;
  milestone?: number | null;
  assigned_to?: number | null;
  tags?: string[];
}

// -------------------------------------------------------------------------
// History (comment) types
// -------------------------------------------------------------------------

/** A single entry in a task/issue history. Comments appear with `comment` field populated. */
export interface TaigaHistoryEntry {
  _type?: string;
  comment?: string;
  comment_html?: string;
  user?: number;
  user_extra_info?: AssignedToExtraInfo | null;
  subject?: string;
  new_value?: string;
  old_value?: string;
  comment_id?: number;
  data?: Record<string, unknown>;
  created_date: string;
}

// -------------------------------------------------------------------------
// API response / error types
// -------------------------------------------------------------------------

/** Auth token response from Taiga */
export interface AuthResponse {
  auth_token: string;
  user: {
    id: number;
    username: string;
    full_name_display: string;
    email: string;
    is_active: boolean;
  };
}

/** Error returned by our extension tools */
export interface TaigaError {
  ok: false;
  error: string;
  httpStatus?: number;
}

/** Success wrapper for all our tool outputs */
export interface TaigaSuccess<T = unknown> {
  ok: true;
  data: T;
}
