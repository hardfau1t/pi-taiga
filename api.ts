// ============================================================================
// Taiga REST API Client — uses Node.js native https (no fetch dependency)
// ============================================================================

import type {
  AuthResponse,
  TaigaUser,
  TaigaProject,
  TaigaTask,
  TaigaIssue,
  TaigaHistoryEntry,
  TaigaStatus,
} from "./types.js";

interface HttpError {
  error: string;
  httpStatus?: number;
  ok: false;
}

interface HttpResponse<T> {
  data: T;
  ok: true;
}

// ------------------------------------------------------------------
// Logging helpers
// ------------------------------------------------------------------

const LOG_DIR = `${process.env.HOME || '/tmp'}/.cache`;
const LOG_FILE = `${LOG_DIR}/pi/taiga-manager.log`;
const DEBUG_LOG_FILE = `${LOG_DIR}/pi/taiga-manager-debug.log`;

function ensureLogDir(file: string) {
  const fs = require('fs');
  try { fs.mkdirSync(`${LOG_DIR}/pi`, { recursive: true }); } catch {}
}

function log(msg: string) {
  ensureLogDir(LOG_FILE);
  const fs = require('fs');
  if (fs.statSync(LOG_FILE).size > 1024 * 1024) { // > 1MB
    fs.writeFileSync(LOG_FILE, '');
  }
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

function logFullDebug(reqInfo: string, body: any) {
  ensureLogDir(DEBUG_LOG_FILE);
  const fs = require('fs');
  try {
    const content = body && typeof body === 'object' ? JSON.stringify(body, null, 2) : String(body || '');
    const safeBody = content.length > 4096 ? content.substring(0, 4096) + '... (truncated)' : content;
    fs.appendFileSync(DEBUG_LOG_FILE, `\n=== ${reqInfo} ===\n${safeBody}\n\n`);
  } catch {}
}

// ------------------------------------------------------------------
// URL helpers
// ------------------------------------------------------------------

function parseUrl(urlStr: string): { protocol: string; host: string; port: number | undefined; path: string } {
  const m = urlStr.match(/^(https?):\/\/([^/:]+)(?::(\d+))?\/?(.*)$/);
  if (!m) throw new Error(`Invalid URL: ${urlStr}`);
  return {
    protocol: m[1],
    host: m[2],
    port: m[3] ? parseInt(m[3], 10) : undefined,
    path: m[4] || '',
  };
}

// Ensures the base URL ends with /api/v1/ (exactly one trailing slash)
function getApiBaseUrl(config: TaigaConfig): string {
  let baseUrl = config.baseUrl;
  if (!baseUrl.endsWith('/')) baseUrl += '/';
  if (!baseUrl.endsWith('/api/v1/')) {
    baseUrl = baseUrl.replace(/\/+$/, '') + '/api/v1/';
  }
  return baseUrl;
}

// ------------------------------------------------------------------
// Authentication Helpers (Auto-Negotiation)
// ------------------------------------------------------------------

function buildAuthHeader(config?: TaigaConfig, forcedPrefix?: 'Bearer' | 'Application'): Record<string, string> {
  if (!config?.authToken) return {};
  
  const cleanToken = config.authToken.trim();
  let prefix: string;
  
  if (forcedPrefix === 'Bearer' || forcedPrefix === 'Application') {
    prefix = `${forcedPrefix} `;
  } else {
    // Auto-detect: JWT tokens contain two dots (header.payload.signature).
    const isJWT = cleanToken.includes('.');
    prefix = isJWT ? 'Bearer ' : 'Application ';
  }
  
  return { Authorization: `${prefix}${cleanToken}` };
}

// ------------------------------------------------------------------
// Main HTTP call logic with automatic URL correction & Auth retry
// ------------------------------------------------------------------

async function httpCall<T>(
  method: string,
  urlStr: string,
  config?: TaigaConfig,
  bodyObj?: Record<string, unknown>,
): Promise<HttpResponse<T> | HttpError> {
  const https = await import('node:https');

  // Determine retry strategies
  // Auth: Try Bearer first if it looks like JWT, else Application. Always fallback to the other on failure.
  let authStrategies: ('Bearer' | 'Application' | null)[] = [];
  if (config?.authToken) {
    const isJWT = config.authToken.includes('.');
    authStrategies = isJWT ? ['Bearer', 'Application'] : ['Application', 'Bearer'];
  } else {
    authStrategies = [null];
  }

  // URL: Start with provided url. If it fails with HTML (frontend), try stripping port or swapping to 8001.
  let currentUrl = urlStr;
  let urlStrategies: string[] = [currentUrl];
  
  const maxRetries = authStrategies.length * urlStrategies.length;
  let attempts = 0;

  while (attempts < maxRetries) {
    // Check if we need to fix the URL (if previous attempt returned HTML/Frontend error)
    const prevError = attempts > 0 ? 'HTML' : null; 
    // Note: We don't strictly know the previous error here easily unless we parse it. 
    // Instead, let's just iterate auth strategies first for the current URL to be faster, 
    // then handle URL correction if those fail with non-JSON errors.

    // Actually, simpler logic:
    // 1. Loop through Auth Strategies for currentUrl.
    // 2. If we get HTML response (Frontend), fix URL and restart loop.
    // 3. If we get "Invalid token" and have more auth strategies, retry.
    
    const u = parseUrl(currentUrl);
    log(`[REQUEST] ${attempts + 1}: ${method} ${currentUrl}`);

    let result: HttpResponse<T> | HttpError;
    
    // Try each auth strategy for this URL
    for (const authAttempt of authStrategies) {
      const headers = buildAuthHeader(config, authAttempt as any);
      log(`[AUTH] Attempting with prefix: ${authAttempt || 'auto'}...`);

      result = await httpCallSingle<T>(method, currentUrl, undefined, bodyObj, headers);
      
      // Success!
      if (result.ok) return result;

      // Check error type
      const errMsg: string = result.error;
      
      // If we got a Taiga auth error, try next strategy
      if ((errMsg.includes('Invalid token') || errMsg.includes('NotAuthenticated')) && 
          authStrategies.indexOf(authAttempt as any) < authStrategies.length - 1) {
        log(`[AUTH] Failed. Retrying with ${authStrategies[authStrategies.indexOf(authAttempt as any) + 1]}...`);
        continue; // Try next auth strategy
      }
      
      // If we got a non-HTML error and we're on port 9000, also try URL variants
      if (urlStrategies.length === 1 && !urlCorrected && currentUrl.includes(':9000')) {
        urlCorrected = true;
        
        // Strategy: Strip :9000 (nginx proxy)
        let fixedUrl = currentUrl.replace(/:9000/, '');
        log(`[URL] Also trying ${fixedUrl} (stripped :9000)`);
        urlStrategies.unshift(fixedUrl);
        
        // Strategy: Try port 8001 (direct backend)
        fixedUrl = `${u.protocol}://${u.host}:8001/${u.path}`;
        log(`[URL] Also trying ${fixedUrl} (backend port)`);
        urlStrategies.unshift(fixedUrl);
      }
      
      // Real error or exhausted strategies
      return result;
    }
    
    // If we are here, we either ran out of auth strategies or had an HTML response
    // Move to next URL strategy
    if (urlStrategies.length > 1) {
      currentUrl = urlStrategies.pop()!;
      attempts++;
      log(`[URL] Next attempt on ${currentUrl}`);
      continue;
    } else {
      // No more URLs to try
      break;
    }
  }

  return result || { error: 'Maximum retries reached', ok: false };
}

// ------------------------------------------------------------------
// Single HTTP request execution
// ------------------------------------------------------------------

async function httpCallSingle<T>(
  method: string,
  urlStr: string,
  config?: TaigaConfig,
  bodyObj?: Record<string, unknown>,
  extraHeaders?: Record<string, string>, // Passed explicitly from loop
): Promise<HttpResponse<T> | HttpError> {
  const https = await import('node:https');
  const u = parseUrl(urlStr);

  log(`[CONNECT] ${u.host}:${u.port || (u.protocol === 'https' ? 443 : 80)}`);

  return new Promise<HttpResponse<T> | HttpError>((resolve) => {
    const headers: Record<string, string> = {
      ...extraHeaders, // Auth header applied here
    };

    if (method !== 'GET' && bodyObj) {
      headers['Content-Type'] = 'application/json';
    } else if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
       // Empty body for mutations is safe if Content-Length is set
    }

    log(`[HEADERS] ${JSON.stringify(headers)}`);

    const req = https.request(
      {
        hostname: u.host,
        port: u.port || (u.protocol === 'https' ? 443 : 80),
        path: '/' + u.path,
        method: method.toUpperCase(),
        headers,
        timeout: 15_000,
      },
      (res) => {
        let data = '';
        
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });

        res.on('end', () => {
          logFullDebug(`RESPONSE_${method}_${urlStr}`, data);
          log(`[RESPONSE] status=${res.statusCode} body_size=${data.length}`);

          // Handle non-2xx
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            let errMsg = `HTTP ${res.statusCode}`;
            try {
              const parsed = JSON.parse(data);
              errMsg = typeof parsed?.detail === 'string' ? parsed.detail : (parsed ? JSON.stringify(parsed) : data || errMsg);
            } catch {
              if (data) errMsg = data.substring(0, 100); // Truncate for logs
            }
            resolve({ error: errMsg, httpStatus: res.statusCode, ok: false });
            return;
          }

          // Handle 204 / Empty
          if (!data.trim()) {
            resolve({ data: undefined as unknown as T, ok: true });
            return;
          }

          // Try parsing JSON
          try {
            const parsed = JSON.parse(data);
            resolve({ data: parsed, ok: true });
          } catch (parseErr) {
            // Non-JSON response (like HTML Frontend)
            const preview = data.substring(0, 100).replace(/"/g, "'");
            resolve({ 
              error: `Server returned HTML/text (Content-Type: ${res.headers['content-type']}). \n` +
                     `This usually means the URL points to the Web UI (Frontend) instead of the API Backend.\n\n` +
                     `Preview: ${preview}`, 
              httpStatus: res.statusCode, 
              ok: false 
            });
          }
        });
      },
    );

    req.on('error', (err) => {
      log(`[ERROR] ${err.message}`);
      resolve({ error: err.message, ok: false });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'Request timed out', ok: false });
    });

    if (bodyObj && method !== 'GET') {
      const body = JSON.stringify(bodyObj);
      req.setHeader('Content-Length', Buffer.byteLength(body));
      req.write(body);
    } else if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
       // Send empty body for mutations just in case, to satisfy HTTP spec
       req.write('{}'); 
    }
    
    req.end();
  });
}

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface TaigaConfig {
  baseUrl: string;
  authToken?: string | null;
  username?: string | null;
  password?: string | null;
}

// ------------------------------------------------------------------
// Auth
// ------------------------------------------------------------------

export async function login(
  config: TaigaConfig,
  username: string,
  password: string,
  authType?: string,
): Promise<{ ok: true; data: AuthResponse } | HttpError> {
  let apiUrl = getApiBaseUrl(config);
  log(`[LOGIN] Attempting to ${apiUrl}/auth`);
  
  const url = `${apiUrl}/auth`;
  const bodyObj = { type: authType || 'normal', username, password };

  const result = await httpCall<{ auth_token: string; user: AuthResponse['user'] }>('POST', url, undefined, bodyObj);
  
  if (!result.ok) return result;

  const rawToken = (result.data as any).auth_token;
  const authResp: AuthResponse = {
    auth_token: rawToken?.trim(), // Ensure clean token
    user: (result.data as any).user,
  };

  config.authToken = authResp.auth_token;
  config.baseUrl = apiUrl.replace('/api/v1/', ''); // Store base URL without /api/v1/ for relative usage
  
  log(`[LOGIN] Success! Token length: ${authResp.auth_token?.length}`);
  return { ok: true, data: authResp };
}

// ------------------------------------------------------------------
// Helper methods (wrappers)
// ------------------------------------------------------------------

function makeUrl(config: TaigaConfig, path: string): string {
  return `${getApiBaseUrl(config)}${path}`;
}

export async function getMe(config: TaigaConfig): Promise<{ ok: true; data: TaigaUser } | HttpError> {
  return httpCall<TaigaUser>('GET', makeUrl(config, 'users/me'), config);
}

export async function listUsers(config: TaigaConfig): Promise<{ ok: true; data: TaigaUser[] } | HttpError> {
  return httpCall<TaigaUser[]>('GET', makeUrl(config, 'users'), config);
}

export async function listProjects(config: TaigaConfig): Promise<{ ok: true; data: TaigaProject[] } | HttpError> {
  const url = makeUrl(config, 'projects');
  log(`[CALL] listProjects -> ${url}`);
  return httpCall<TaigaProject[]>('GET', url, config);
}

export async function getProjectBySlug(config: TaigaConfig, slug: string): Promise<{ ok: true; data: TaigaProject } | HttpError> {
  const url = makeUrl(config, `projects/by_slug?slug=${encodeURIComponent(slug)}`);
  log(`[CALL] getProjectBySlug(${slug}) -> ${url}`);
  return httpCall<TaigaProject>('GET', url, config);
}

export async function listTaskStatuses(config: TaigaConfig, projectId: number): Promise<{ ok: true; data: TaigaStatus[] } | HttpError> {
  const url = makeUrl(config, `task-statuses?project=${projectId}`);
  log(`[CALL] listTaskStatuses(project=${projectId}) -> ${url}`);
  return httpCall<TaigaStatus[]>('GET', url, config);
}

export async function listIssueStatuses(config: TaigaConfig, projectId: number): Promise<{ ok: true; data: TaigaStatus[] } | HttpError> {
  const url = makeUrl(config, `issue-statuses?project=${projectId}`);
  log(`[CALL] listIssueStatuses(project=${projectId}) -> ${url}`);
  return httpCall<TaigaStatus[]>('GET', url, config);
}

export async function listIssueTypes(config: TaigaConfig, projectId: number): Promise<{ ok: true; data: { id: number; name: string; color: string }[] } | HttpError> {
  const url = makeUrl(config, `issue-types?project=${projectId}`);
  log(`[CALL] listIssueTypes(project=${projectId}) -> ${url}`);
  return httpCall<{ id: number; name: string; color: string }[]>('GET', url, config);
}

export async function listPriorities(config: TaigaConfig, projectId: number): Promise<{ ok: true; data: { id: number; name: string; order: number }[] } | HttpError> {
  const url = makeUrl(config, `priorities?project=${projectId}`);
  log(`[CALL] listPriorities(project=${projectId}) -> ${url}`);
  return httpCall<{ id: number; name: string; order: number }[]>('GET', url, config);
}

export async function listSeverities(config: TaigaConfig, projectId: number): Promise<{ ok: true; data: { id: number; name: string; order: number }[] } | HttpError> {
  const url = makeUrl(config, `severities?project=${projectId}`);
  log(`[CALL] listSeverities(project=${projectId}) -> ${url}`);
  return httpCall<{ id: number; name: string; order: number }[]>('GET', url, config);
}

export async function listMilestones(config: TaigaConfig, projectId: number): Promise<{ ok: true; data: TaigaMilestone[] } | HttpError> {
  const url = makeUrl(config, `milestones?project=${projectId}`);
  log(`[CALL] listMilestones(project=${projectId}) -> ${url}`);
  return httpCall<TaigaMilestone[]>('GET', url, config);
}

export async function createTask(config: TaigaConfig, fields: Record<string, unknown>): Promise<{ ok: true; data: TaigaTask } | HttpError> {
  const url = makeUrl(config, 'tasks');
  log(`[CALL] createTask -> ${url}`);
  return httpCall<TaigaTask>('POST', url, config, fields);
}

export async function getTask(config: TaigaConfig, taskId: number): Promise<{ ok: true; data: TaigaTask } | HttpError> {
  const url = makeUrl(config, `tasks/${taskId}`);
  log(`[CALL] getTask(${taskId}) -> ${url}`);
  return httpCall<TaigaTask>('GET', url, config);
}

export async function getTaskByRef(config: TaigaConfig, ref: string, projectId: number): Promise<{ ok: true; data: TaigaTask } | HttpError> {
  const url = makeUrl(config, `tasks/by_ref?ref=${encodeURIComponent(ref)}&project=${projectId}`);
  log(`[CALL] getTaskByRef(ref=${ref}, project=${projectId}) -> ${url}`);
  return httpCall<TaigaTask>('GET', url, config);
}

export async function updateTask(config: TaigaConfig, taskId: number, fields: Record<string, unknown>): Promise<{ ok: true; data: TaigaTask } | HttpError> {
  const url = makeUrl(config, `tasks/${taskId}`);
  log(`[CALL] updateTask(${taskId}) -> ${url}`);
  return httpCall<TaigaTask>('PATCH', url, config, fields);
}

export async function deleteTask(config: TaigaConfig, taskId: number): Promise<{ ok: true } | HttpError> {
  const url = makeUrl(config, `tasks/${taskId}`);
  log(`[CALL] deleteTask(${taskId}) -> ${url}`);
  const result = await httpCall<void>('DELETE', url, config);
  if (!result.ok) return result;
  return { ok: true };
}

export async function listTasks(config: TaigaConfig, filters?: any): Promise<{ ok: true; data: TaigaTask[] } | HttpError> {
  let baseUrl = config.baseUrl.endsWith('/api/v1') ? `${config.baseUrl.replace(/\/api\/v1$/, '')}` : config.baseUrl;
  const finalUrl = makeUrl({ ...config, baseUrl }, Object.keys(filters || {}).length > 0 ? `tasks?${Object.entries(filters).map(([k,v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join('&')}` : 'tasks');
  
  log(`[CALL] listTasks -> ${finalUrl}, filters=${JSON.stringify(filters)}`);
  return httpCall<TaigaTask[]>('GET', finalUrl, config);
}

export async function watchTask(config: TaigaConfig, taskId: number): Promise<{ ok: true } | HttpError> {
  const url = makeUrl(config, `tasks/${taskId}/watch`);
  log(`[CALL] watchTask(${taskId}) -> ${url}`);
  const result = await httpCall<void>('POST', url, config);
  return result.ok ? { ok: true } : result;
}

export async function unwatchTask(config: TaigaConfig, taskId: number): Promise<{ ok: true } | HttpError> {
  const url = makeUrl(config, `tasks/${taskId}/unwatch`);
  log(`[CALL] unwatchTask(${taskId}) -> ${url}`);
  const result = await httpCall<void>('POST', url, config);
  return result.ok ? { ok: true } : result;
}

export async function createIssue(config: TaigaConfig, fields: Record<string, unknown>): Promise<{ ok: true; data: TaigaIssue } | HttpError> {
  const url = makeUrl(config, 'issues');
  log(`[CALL] createIssue -> ${url}`);
  return httpCall<TaigaIssue>('POST', url, config, fields);
}

export async function getIssue(config: TaigaConfig, issueId: number): Promise<{ ok: true; data: TaigaIssue } | HttpError> {
  const url = makeUrl(config, `issues/${issueId}`);
  log(`[CALL] getIssue(${issueId}) -> ${url}`);
  return httpCall<TaigaIssue>('GET', url, config);
}

export async function getIssueByRef(config: TaigaConfig, ref: string, projectId: number): Promise<{ ok: true; data: TaigaIssue } | HttpError> {
  const url = makeUrl(config, `issues/by_ref?ref=${encodeURIComponent(ref)}&project=${projectId}`);
  log(`[CALL] getIssueByRef(ref=${ref}, project=${projectId}) -> ${url}`);
  return httpCall<TaigaIssue>('GET', url, config);
}

export async function updateIssue(config: TaigaConfig, issueId: number, fields: Record<string, unknown>): Promise<{ ok: true; data: TaigaIssue } | HttpError> {
  const url = makeUrl(config, `issues/${issueId}`);
  log(`[CALL] updateIssue(${issueId}) -> ${url}`);
  return httpCall<TaigaIssue>('PATCH', url, config, fields);
}

export async function deleteIssue(config: TaigaConfig, issueId: number): Promise<{ ok: true } | HttpError> {
  const url = makeUrl(config, `issues/${issueId}`);
  log(`[CALL] deleteIssue(${issueId}) -> ${url}`);
  const result = await httpCall<void>('DELETE', url, config);
  return result.ok ? { ok: true } : result;
}

export async function listIssues(config: TaigaConfig, filters?: any): Promise<{ ok: true; data: TaigaIssue[] } | HttpError> {
  let baseUrl = config.baseUrl.endsWith('/api/v1') ? `${config.baseUrl.replace(/\/api\/v1$/, '')}` : config.baseUrl;
  const urlStr = Object.keys(filters || {}).length > 0 
    ? `issues?${Object.entries(filters).map(([k,v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join('&')}`
    : 'issues';
  const finalUrl = makeUrl({ ...config, baseUrl }, urlStr);

  log(`[CALL] listIssues -> ${finalUrl}, filters=${JSON.stringify(filters)}`);
  return httpCall<TaigaIssue[]>('GET', finalUrl, config);
}

export async function getTaskHistory(config: TaigaConfig, taskId: number): Promise<{ ok: true; data: TaigaHistoryEntry[] } | HttpError> {
  const url = makeUrl(config, `history/task/${taskId}`);
  log(`[CALL] getTaskHistory(${taskId}) -> ${url}`);
  const result = await httpCall<TaigaHistoryEntry[]>('GET', url, config);
  return result.ok ? result : result as any;
}

export async function getIssueHistory(config: TaigaConfig, issueId: number): Promise<{ ok: true; data: TaigaHistoryEntry[] } | HttpError> {
  const url = makeUrl(config, `history/issue/${issueId}`);
  log(`[CALL] getIssueHistory(${issueId}) -> ${url}`);
  const result = await httpCall<TaigaHistoryEntry[]>('GET', url, config);
  return result.ok ? result : result as any;
}

export async function search(config: TaigaConfig, query: string, filters?: { project?: number }): Promise<{ ok: true; data: Record<string, unknown>[] } | HttpError> {
  let params = `search?q=${encodeURIComponent(query)}`;
  if (filters?.project) {
    params += `&project=${filters.project}`;
  }
  const url = makeUrl(config, params);
  log(`[CALL] search(query="${query}", filters=${JSON.stringify(filters)}) -> ${url}`);
  return httpCall<Record<string, unknown>[]>('GET', url, config);
}
