#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);
const FRONTEND_DIR = path.resolve(__dirname, "../frontend");
const DATA_DIR = path.resolve(__dirname, "./data");
const ACCOUNTS_FILE = path.resolve(DATA_DIR, "accounts.json");
const BACKGROUND_REFRESH_FILE = path.resolve(DATA_DIR, "background_refresh.json");

const OAUTH = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeURL: "https://claude.ai/oauth/authorize",
  tokenURL: "https://platform.claude.com/v1/oauth/token",
  redirectURI: "https://platform.claude.com/oauth/code/callback",
  usageURL: "https://api.anthropic.com/api/oauth/usage",
  scopeOAuth:
    "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers",
  scopeInference: "user:inference",
  codeVerifierCharset:
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
};

const DEFAULT_USAGE_USER_AGENT = "claude-code/2.1.7";
const REQUEST_TIMEOUT_MS = 30 * 1000;
const TOKEN_REFRESH_SKEW_MS = 3 * 60 * 1000;
const BACKGROUND_REFRESH_ALLOWED_INTERVALS = [1, 10, 30, 60, 120, 300];
const DEFAULT_BACKGROUND_REFRESH_INTERVAL_SECONDS = 60;
const DATA_TYPE = "sub2api-data";
const LEGACY_DATA_TYPE = "sub2api-bundle";
const DATA_VERSION = 1;

const SESSION_TTL_MS = 30 * 60 * 1000;
const sessions = new Map();

const PLATFORMS = new Set(["anthropic", "openai", "gemini", "antigravity", "sora"]);
const ACCOUNT_TYPES = new Set(["oauth", "setup-token", "apikey", "upstream"]);
const ACCOUNT_STATUS = new Set(["active", "inactive", "error"]);
const PROXY_PROTOCOLS = new Set(["http", "https", "socks5", "socks5h"]);
const PROXY_STATUS = new Set(["active", "inactive"]);

let accounts = [];
let nextAccountID = 1;
let proxies = [];
let nextProxyID = 1;
let refreshUsageTask = null;
let backgroundRefreshTicker = null;
const backgroundRefresh = {
  enabled: false,
  interval_seconds: DEFAULT_BACKGROUND_REFRESH_INTERVAL_SECONDS,
  task_enabled: false,
  task_content: "",
  running: false,
  next_run_at: null,
  last_started_at: null,
  last_finished_at: null,
  last_error: null,
  last_result: null
};

function nowISO() {
  return new Date().toISOString();
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function deepCloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultSeedProxies() {
  return [];
}

function defaultSeedAccounts() {
  const createdAt = nowISO();
  return [
    {
      id: 1,
      name: "claude-oauth-main",
      notes: "主 Anthropic OAuth 账号",
      platform: "anthropic",
      type: "oauth",
      credentials: {},
      extra: { email_address: "owner+claude@example.com" },
      proxy_id: null,
      concurrency: 1,
      current_concurrency: 0,
      priority: 1,
      rate_multiplier: 1,
      status: "active",
      error_message: null,
      last_used_at: null,
      expires_at: null,
      auto_pause_on_expired: false,
      schedulable: true,
      created_at: createdAt,
      updated_at: createdAt
    },
    {
      id: 2,
      name: "openai-oauth-01",
      notes: "OpenAI OAuth 账号",
      platform: "openai",
      type: "oauth",
      credentials: {},
      extra: { email_address: "owner+openai@example.com" },
      proxy_id: null,
      concurrency: 2,
      current_concurrency: 1,
      priority: 2,
      rate_multiplier: 1,
      status: "active",
      error_message: null,
      last_used_at: createdAt,
      expires_at: null,
      auto_pause_on_expired: false,
      schedulable: true,
      created_at: createdAt,
      updated_at: createdAt
    },
    {
      id: 3,
      name: "gemini-apikey-01",
      notes: "Gemini API Key 账号",
      platform: "gemini",
      type: "apikey",
      credentials: {},
      extra: { email_address: "owner+gemini@example.com" },
      proxy_id: null,
      concurrency: 1,
      current_concurrency: 0,
      priority: 1,
      rate_multiplier: 1,
      status: "inactive",
      error_message: null,
      last_used_at: null,
      expires_at: null,
      auto_pause_on_expired: false,
      schedulable: false,
      created_at: createdAt,
      updated_at: createdAt
    }
  ];
}

function normalizeProxy(raw) {
  const createdAt = typeof raw.created_at === "string" ? raw.created_at : nowISO();
  const updatedAt = typeof raw.updated_at === "string" ? raw.updated_at : createdAt;
  const id = Number(raw.id);
  const port = Number(raw.port);
  const status = normalizeProxyStatus(raw.status);

  return {
    id: Number.isFinite(id) && id > 0 ? id : 0,
    name: String(raw.name || ""),
    protocol: String(raw.protocol || "").trim().toLowerCase(),
    host: String(raw.host || "").trim(),
    port: Number.isFinite(port) ? Math.floor(port) : 0,
    username: raw.username == null ? "" : String(raw.username),
    password: raw.password == null ? "" : String(raw.password),
    status: PROXY_STATUS.has(status) ? status : "active",
    created_at: createdAt,
    updated_at: updatedAt
  };
}

function normalizeAccount(raw) {
  const createdAt = typeof raw.created_at === "string" ? raw.created_at : nowISO();
  const updatedAt = typeof raw.updated_at === "string" ? raw.updated_at : createdAt;
  const proxyID = Number(raw.proxy_id);
  const concurrency = Number(raw.concurrency);
  const priority = Number(raw.priority);
  const rateMultiplier = Number(raw.rate_multiplier);
  const expiresAt = Number(raw.expires_at);

  return {
    id: Number(raw.id) || 0,
    name: String(raw.name || ""),
    notes: raw.notes == null ? null : String(raw.notes),
    platform: String(raw.platform || "anthropic"),
    type: String(raw.type || "oauth"),
    credentials: raw.credentials && typeof raw.credentials === "object" ? raw.credentials : {},
    extra: raw.extra && typeof raw.extra === "object" ? raw.extra : {},
    proxy_id: Number.isFinite(proxyID) && proxyID > 0 ? proxyID : null,
    concurrency: Number.isFinite(concurrency) && concurrency >= 0 ? Math.floor(concurrency) : 1,
    current_concurrency: Number(raw.current_concurrency || 0),
    priority: Number.isFinite(priority) && priority >= 0 ? Math.floor(priority) : 1,
    rate_multiplier: Number.isFinite(rateMultiplier) && rateMultiplier >= 0 ? rateMultiplier : 1,
    status: ACCOUNT_STATUS.has(String(raw.status)) ? String(raw.status) : "active",
    error_message: raw.error_message == null ? null : String(raw.error_message),
    last_used_at: raw.last_used_at == null ? null : String(raw.last_used_at),
    expires_at: raw.expires_at == null || !Number.isFinite(expiresAt) ? null : Math.floor(expiresAt),
    auto_pause_on_expired: raw.auto_pause_on_expired === true,
    schedulable: raw.schedulable !== false,
    created_at: createdAt,
    updated_at: updatedAt
  };
}

function createProxyRecord(input) {
  const createdAt = nowISO();
  const status = normalizeProxyStatus(input.status);
  const proxy = {
    id: nextProxyID,
    name: String(input.name || "").trim(),
    protocol: String(input.protocol || "").trim().toLowerCase(),
    host: String(input.host || "").trim(),
    port: Math.floor(Number(input.port || 0)),
    username: input.username == null ? "" : String(input.username),
    password: input.password == null ? "" : String(input.password),
    status: PROXY_STATUS.has(status) ? status : "active",
    created_at: createdAt,
    updated_at: createdAt
  };
  nextProxyID += 1;
  return proxy;
}

function createAccountRecord(input) {
  const createdAt = nowISO();
  const proxyID = Number(input.proxy_id);
  const expiresAt = Number(input.expires_at);
  const account = {
    id: nextAccountID,
    name: String(input.name || "").trim(),
    notes: input.notes == null ? null : String(input.notes),
    platform: String(input.platform || "anthropic"),
    type: String(input.type || "oauth"),
    credentials: isObject(input.credentials) ? deepCloneJSON(input.credentials) : {},
    extra: isObject(input.extra) ? deepCloneJSON(input.extra) : {},
    proxy_id: Number.isFinite(proxyID) && proxyID > 0 ? Math.floor(proxyID) : null,
    concurrency: Math.max(0, toNonNegativeInt(input.concurrency, 1)),
    current_concurrency: Number(input.current_concurrency || 0),
    priority: Math.max(0, toNonNegativeInt(input.priority, 1)),
    rate_multiplier: Number.isFinite(Number(input.rate_multiplier))
      ? Math.max(0, Number(input.rate_multiplier))
      : 1,
    status: ACCOUNT_STATUS.has(String(input.status)) ? String(input.status) : "active",
    error_message: input.error_message == null ? null : String(input.error_message),
    last_used_at: input.last_used_at == null ? null : String(input.last_used_at),
    expires_at: input.expires_at == null || !Number.isFinite(expiresAt) ? null : Math.floor(expiresAt),
    auto_pause_on_expired: input.auto_pause_on_expired === true,
    schedulable: input.schedulable !== false,
    created_at: createdAt,
    updated_at: createdAt
  };
  nextAccountID += 1;
  return account;
}

function loadAccounts() {
  ensureDataDir();
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) {
      proxies = defaultSeedProxies();
      accounts = defaultSeedAccounts();
      nextProxyID = proxies.reduce((maxID, item) => Math.max(maxID, item.id), 0) + 1;
      nextAccountID = accounts.reduce((maxID, item) => Math.max(maxID, item.id), 0) + 1;
      saveAccounts();
      return;
    }

    const raw = fs.readFileSync(ACCOUNTS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const proxyList = Array.isArray(parsed.proxies) ? parsed.proxies : [];
    const list = Array.isArray(parsed.accounts) ? parsed.accounts : [];
    proxies = proxyList.map(normalizeProxy).filter((item) => item.id > 0);
    accounts = list.map(normalizeAccount).filter((item) => item.id > 0);
    nextProxyID = Number(parsed.next_proxy_id) || proxies.reduce((maxID, item) => Math.max(maxID, item.id), 0) + 1;
    nextAccountID = Number(parsed.next_id) || accounts.reduce((maxID, item) => Math.max(maxID, item.id), 0) + 1;
  } catch (err) {
    console.error("[claudetest] failed to load accounts:", err);
    proxies = defaultSeedProxies();
    accounts = defaultSeedAccounts();
    nextProxyID = proxies.reduce((maxID, item) => Math.max(maxID, item.id), 0) + 1;
    nextAccountID = accounts.reduce((maxID, item) => Math.max(maxID, item.id), 0) + 1;
    saveAccounts();
  }
}

function saveAccounts() {
  ensureDataDir();
  const payload = {
    next_proxy_id: nextProxyID,
    proxies,
    next_id: nextAccountID,
    accounts
  };
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(payload, null, 2), "utf8");
}

function normalizeBackgroundRefreshConfig(raw) {
  const enabled = raw && raw.enabled === true;
  const interval = Number(raw && raw.interval_seconds);
  const task_enabled = !!(raw && raw.task_enabled === true);
  const task_content = typeof (raw && raw.task_content) === "string" ? raw.task_content : "";
  return {
    enabled,
    interval_seconds: BACKGROUND_REFRESH_ALLOWED_INTERVALS.includes(interval)
      ? interval
      : DEFAULT_BACKGROUND_REFRESH_INTERVAL_SECONDS,
    task_enabled,
    task_content
  };
}

function loadBackgroundRefreshConfig() {
  ensureDataDir();
  try {
    if (!fs.existsSync(BACKGROUND_REFRESH_FILE)) {
      saveBackgroundRefreshConfig();
      return;
    }
    const raw = fs.readFileSync(BACKGROUND_REFRESH_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const cfg = normalizeBackgroundRefreshConfig(parsed);
    backgroundRefresh.enabled = cfg.enabled;
    backgroundRefresh.interval_seconds = cfg.interval_seconds;
    backgroundRefresh.task_enabled = cfg.task_enabled;
    backgroundRefresh.task_content = cfg.task_content;
  } catch (err) {
    console.error("[claudetest] failed to load background refresh config:", err);
    backgroundRefresh.enabled = false;
    backgroundRefresh.interval_seconds = DEFAULT_BACKGROUND_REFRESH_INTERVAL_SECONDS;
    saveBackgroundRefreshConfig();
  }
}

function saveBackgroundRefreshConfig() {
  ensureDataDir();
  const payload = {
    enabled: backgroundRefresh.enabled,
    interval_seconds: backgroundRefresh.interval_seconds,
    task_enabled: backgroundRefresh.task_enabled,
    task_content: backgroundRefresh.task_content
  };
  fs.writeFileSync(BACKGROUND_REFRESH_FILE, JSON.stringify(payload, null, 2), "utf8");
}

function scheduleNextBackgroundRun() {
  if (!backgroundRefresh.enabled) {
    backgroundRefresh.next_run_at = null;
    return;
  }
  backgroundRefresh.next_run_at = new Date(
    Date.now() + backgroundRefresh.interval_seconds * 1000
  ).toISOString();
}

function cleanupSessions() {
  const now = Date.now();
  for (const [sessionID, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(sessionID);
    }
  }
}

setInterval(cleanupSessions, 5 * 60 * 1000).unref();

function parseJSONBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,If-None-Match"
  };
}

function writeJSON(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...corsHeaders(),
    ...extraHeaders
  });
  res.end(body);
}

function writeNoContent(res, extraHeaders = {}) {
  res.writeHead(204, {
    ...corsHeaders(),
    ...extraHeaders
  });
  res.end();
}

function writeNotModified(res, etag) {
  res.writeHead(304, {
    ...corsHeaders(),
    ETag: etag
  });
  res.end();
}

function base64UrlEncode(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function generateState() {
  return base64UrlEncode(crypto.randomBytes(32));
}

function generateSessionID() {
  return crypto.randomBytes(16).toString("hex");
}

function generateCodeVerifier() {
  const targetLen = 32;
  const charsetLen = OAUTH.codeVerifierCharset.length;
  const limit = 256 - (256 % charsetLen);
  const chars = [];

  while (chars.length < targetLen) {
    const randBuf = crypto.randomBytes(targetLen * 2);
    for (const value of randBuf) {
      if (value < limit) {
        chars.push(OAUTH.codeVerifierCharset[value % charsetLen]);
        if (chars.length >= targetLen) break;
      }
    }
  }

  return base64UrlEncode(Buffer.from(chars.join(""), "ascii"));
}

function generateCodeChallenge(codeVerifier) {
  const hash = crypto.createHash("sha256").update(codeVerifier, "utf8").digest();
  return base64UrlEncode(hash);
}

function buildAuthorizationURL({ state, codeChallenge, scope }) {
  const encodedRedirectURI = encodeURIComponent(OAUTH.redirectURI);
  const encodedScope = encodeURIComponent(scope).replace(/%20/g, "+");

  return (
    `${OAUTH.authorizeURL}?code=true` +
    `&client_id=${encodeURIComponent(OAUTH.clientId)}` +
    `&response_type=code` +
    `&redirect_uri=${encodedRedirectURI}` +
    `&scope=${encodedScope}` +
    `&code_challenge=${encodeURIComponent(codeChallenge)}` +
    `&code_challenge_method=S256` +
    `&state=${encodeURIComponent(state)}`
  );
}

function parseOAuthCode(codeInput) {
  const raw = String(codeInput || "").trim();
  const hashIndex = raw.indexOf("#");
  if (hashIndex === -1) {
    return { code: raw, state: "" };
  }
  return {
    code: raw.slice(0, hashIndex),
    state: raw.slice(hashIndex + 1)
  };
}

async function fetchJSONWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { response, data, rawText: text };
  } finally {
    clearTimeout(timer);
  }
}

async function exchangeCodeForToken({ codeInput, codeVerifier, isSetupToken }) {
  const { code, state } = parseOAuthCode(codeInput);
  if (!code) {
    throw new Error("authorization code is empty");
  }

  const body = {
    code,
    grant_type: "authorization_code",
    client_id: OAUTH.clientId,
    redirect_uri: OAUTH.redirectURI,
    code_verifier: codeVerifier
  };
  if (state) {
    body.state = state;
  }
  if (isSetupToken) {
    body.expires_in = 31536000;
  }

  const { response, data, rawText } = await fetchJSONWithTimeout(
    OAUTH.tokenURL,
    {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "User-Agent": "axios/1.8.4"
      },
      body: JSON.stringify(body)
    },
    REQUEST_TIMEOUT_MS
  );

  if (!response.ok) {
    throw new Error(`token exchange failed: status ${response.status}, body: ${rawText}`);
  }
  if (!isObject(data)) {
    throw new Error("token exchange failed: invalid response body");
  }

  const expiresIn = Number(data.expires_in || 0);
  return {
    access_token: String(data.access_token || ""),
    token_type: String(data.token_type || ""),
    expires_in: Number.isFinite(expiresIn) ? expiresIn : 0,
    expires_at: Math.floor(Date.now() / 1000) + (Number.isFinite(expiresIn) ? expiresIn : 0),
    refresh_token: String(data.refresh_token || ""),
    scope: String(data.scope || ""),
    org_uuid:
      data.organization && typeof data.organization.uuid === "string" ? data.organization.uuid : "",
    account_uuid: data.account && typeof data.account.uuid === "string" ? data.account.uuid : "",
    email_address:
      data.account && typeof data.account.email_address === "string" ? data.account.email_address : ""
  };
}

async function fetchClaudeUsage(accessToken) {
  const { response, data, rawText } = await fetchJSONWithTimeout(
    OAUTH.usageURL,
    {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": DEFAULT_USAGE_USER_AGENT
      }
    },
    REQUEST_TIMEOUT_MS
  );

  if (!response.ok) {
    throw new Error(`usage fetch failed: status ${response.status}, body: ${rawText}`);
  }
  if (!isObject(data)) {
    throw new Error("usage fetch failed: invalid response");
  }

  return {
    updated_at: nowISO(),
    five_hour: isObject(data.five_hour)
      ? {
          utilization: Number(data.five_hour.utilization || 0),
          resets_at: String(data.five_hour.resets_at || "")
        }
      : null,
    seven_day: isObject(data.seven_day)
      ? {
          utilization: Number(data.seven_day.utilization || 0),
          resets_at: String(data.seven_day.resets_at || "")
        }
      : null,
    seven_day_sonnet: isObject(data.seven_day_sonnet)
      ? {
          utilization: Number(data.seven_day_sonnet.utilization || 0),
          resets_at: String(data.seven_day_sonnet.resets_at || "")
        }
      : null
  };
}

async function refreshSingleAccountUsage(account) {
  if (account.platform !== "anthropic") {
    return { account_id: account.id, refreshed: false, reason: "platform_not_supported" };
  }

  const accessToken =
    isObject(account.credentials) && typeof account.credentials.access_token === "string"
      ? account.credentials.access_token.trim()
      : "";
  if (!accessToken) {
    return { account_id: account.id, refreshed: false, reason: "missing_access_token" };
  }

  try {
    const usage = await fetchClaudeUsage(accessToken);
    const nextExtra = isObject(account.extra) ? { ...account.extra } : {};
    nextExtra.usage = usage;
    nextExtra.usage_error = null;
    account.extra = nextExtra;
    account.updated_at = nowISO();
    return { account_id: account.id, refreshed: true };
  } catch (err) {
    const nextExtra = isObject(account.extra) ? { ...account.extra } : {};
    nextExtra.usage_error = String(err.message || err);
    nextExtra.usage_error_at = nowISO();
    account.extra = nextExtra;
    account.updated_at = nowISO();
    return { account_id: account.id, refreshed: false, reason: "fetch_failed", error: String(err.message || err) };
  }
}

function fireClaudeTask(account, taskContent) {
  if (account.platform !== "anthropic") return;
  const accessToken =
    isObject(account.credentials) && typeof account.credentials.access_token === "string"
      ? account.credentials.access_token.trim()
      : "";
  if (!accessToken) return;

  const body = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    stream: false,
    messages: [{ role: "user", content: taskContent }]
  });

  fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14",
      "User-Agent": "claude-cli/2.1.22 (external, cli)",
      "X-App": "cli",
      "Anthropic-Dangerous-Direct-Browser-Access": "true"
    },
    body
  }).then((res) => {
    if (res.body) res.body.cancel();
  }).catch(() => {});
}

function needsTokenRefresh(account) {
  if (account.platform !== "anthropic") return false;
  if (account.type !== "oauth" && account.type !== "setup-token") return false;
  if (!isObject(account.credentials)) return false;
  const refreshToken = account.credentials.refresh_token;
  if (!refreshToken || typeof refreshToken !== "string" || !refreshToken.trim()) return false;
  const expiresAt = account.credentials.expires_at;
  if (expiresAt == null) return true;
  const expiresAtMs = Number(expiresAt) * 1000;
  if (!Number.isFinite(expiresAtMs)) return true;
  return expiresAtMs - Date.now() <= TOKEN_REFRESH_SKEW_MS;
}

async function refreshSingleAccountToken(account) {
  const refreshToken = String(account.credentials.refresh_token || "").trim();
  if (!refreshToken) {
    return { account_id: account.id, refreshed: false, reason: "no_refresh_token" };
  }
  try {
    const { response, data, rawText } = await fetchJSONWithTimeout(
      OAUTH.tokenURL,
      {
        method: "POST",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/json",
          "User-Agent": "axios/1.8.4"
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: OAUTH.clientId
        })
      },
      REQUEST_TIMEOUT_MS
    );
    if (!response.ok) {
      throw new Error(`token refresh failed: status ${response.status}, body: ${rawText}`);
    }
    if (!isObject(data) || !data.access_token) {
      throw new Error("token refresh failed: invalid response body");
    }
    const expiresIn = Number(data.expires_in || 0);
    const expiresAt = Math.floor(Date.now() / 1000) + (Number.isFinite(expiresIn) ? expiresIn : 0);
    const newCredentials = { ...account.credentials };
    newCredentials.access_token = String(data.access_token);
    newCredentials.token_type = String(data.token_type || "Bearer");
    newCredentials.expires_in = expiresIn;
    newCredentials.expires_at = expiresAt;
    if (data.refresh_token) newCredentials.refresh_token = String(data.refresh_token);
    if (data.scope) newCredentials.scope = String(data.scope);
    account.credentials = newCredentials;
    account.updated_at = nowISO();
    return { account_id: account.id, refreshed: true };
  } catch (err) {
    return { account_id: account.id, refreshed: false, reason: "refresh_failed", error: String(err.message || err) };
  }
}

async function refreshAllExpiredTokens() {
  const results = [];
  for (const account of accounts) {
    if (needsTokenRefresh(account)) {
      const result = await refreshSingleAccountToken(account);
      results.push(result);
    }
  }
  if (results.length > 0) {
    saveAccounts();
  }
  return results;
}

async function forceRefreshAllUsage() {
  if (refreshUsageTask) {
    return refreshUsageTask;
  }

  refreshUsageTask = (async () => {
    const results = [];
    for (const account of accounts) {
      const result = await refreshSingleAccountUsage(account);
      results.push(result);
    }
    saveAccounts();
    return {
      total: results.length,
      refreshed: results.filter((item) => item.refreshed).length,
      failed: results.filter((item) => !item.refreshed).length,
      results
    };
  })();

  try {
    return await refreshUsageTask;
  } finally {
    refreshUsageTask = null;
  }
}

async function runBackgroundRefreshCycle(source) {
  if (backgroundRefresh.running) {
    return forceRefreshAllUsage();
  }

  backgroundRefresh.running = true;
  backgroundRefresh.last_started_at = nowISO();
  backgroundRefresh.last_error = null;

  try {
    const tokenResults = await refreshAllExpiredTokens();
    const result = await forceRefreshAllUsage();
    if (backgroundRefresh.task_enabled && backgroundRefresh.task_content) {
      for (const account of accounts) {
        fireClaudeTask(account, backgroundRefresh.task_content);
      }
    }
    const tokenRefreshed = tokenResults.filter((r) => r.refreshed).length;
    const tokenFailed = tokenResults.filter((r) => !r.refreshed && r.reason !== "no_refresh_token" && r.reason !== undefined && r.reason !== "platform_not_supported").length;
    backgroundRefresh.last_result = {
      source,
      at: nowISO(),
      total: result.total,
      refreshed: result.refreshed,
      failed: result.failed,
      token_refreshed: tokenRefreshed,
      token_failed: tokenFailed
    };
    return result;
  } catch (err) {
    const message = String(err.message || err);
    backgroundRefresh.last_error = message;
    backgroundRefresh.last_result = {
      source,
      at: nowISO(),
      error: message
    };
    throw err;
  } finally {
    backgroundRefresh.running = false;
    backgroundRefresh.last_finished_at = nowISO();
    scheduleNextBackgroundRun();
  }
}

function startBackgroundRefreshTicker() {
  if (backgroundRefreshTicker) {
    clearInterval(backgroundRefreshTicker);
    backgroundRefreshTicker = null;
  }

  scheduleNextBackgroundRun();

  backgroundRefreshTicker = setInterval(() => {
    if (!backgroundRefresh.enabled) return;
    if (backgroundRefresh.running) return;
    if (!backgroundRefresh.next_run_at) return;

    const due = new Date(backgroundRefresh.next_run_at).getTime();
    if (!Number.isFinite(due)) {
      scheduleNextBackgroundRun();
      return;
    }
    if (Date.now() < due) return;

    runBackgroundRefreshCycle("scheduler").catch((err) => {
      console.error("[claudetest] background refresh failed:", err);
    });
  }, 1000);

  backgroundRefreshTicker.unref();
}

function applyBackgroundRefreshConfig(input) {
  if (input && typeof input.enabled === "boolean") {
    backgroundRefresh.enabled = input.enabled;
  }
  if (input && input.interval_seconds != null) {
    const nextInterval = Number(input.interval_seconds);
    if (BACKGROUND_REFRESH_ALLOWED_INTERVALS.includes(nextInterval)) {
      backgroundRefresh.interval_seconds = nextInterval;
    } else {
      throw new Error(
        `interval_seconds must be one of: ${BACKGROUND_REFRESH_ALLOWED_INTERVALS.join(", ")}`
      );
    }
  }
  if (input && typeof input.task_enabled === "boolean") {
    backgroundRefresh.task_enabled = input.task_enabled;
  }
  if (input && typeof input.task_content === "string") {
    backgroundRefresh.task_content = String(input.task_content);
  }
  scheduleNextBackgroundRun();
  saveBackgroundRefreshConfig();
}

function toPositiveInt(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function toNonNegativeInt(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function normalizeProxyStatus(status) {
  const normalized = String(status || "")
    .trim()
    .toLowerCase();
  if (!normalized) return "";
  if (normalized === "disabled") return "inactive";
  return normalized;
}

function buildProxyKey(protocol, host, port, username, password) {
  return `${String(protocol || "").trim()}|${String(host || "").trim()}|${Number(port || 0)}|${String(
    username || ""
  ).trim()}|${String(password || "").trim()}`;
}

function defaultProxyName(name) {
  const value = String(name || "").trim();
  return value || "imported-proxy";
}

function parseAccountIDs(reqURL) {
  const parts = [];
  const rawValues = reqURL.searchParams.getAll("ids");
  if (rawValues.length === 0) {
    const single = String(reqURL.searchParams.get("ids") || "").trim();
    if (single) rawValues.push(single);
  }

  for (const value of rawValues) {
    const chunks = String(value)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    parts.push(...chunks);
  }

  const ids = [];
  for (const item of parts) {
    const id = Number(item);
    if (!Number.isFinite(id) || id <= 0 || !Number.isInteger(id)) {
      throw new Error(`invalid account id: ${item}`);
    }
    ids.push(id);
  }
  return ids;
}

function parseIncludeProxies(reqURL) {
  const raw = String(reqURL.searchParams.get("include_proxies") || "")
    .trim()
    .toLowerCase();
  if (!raw) return true;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`invalid include_proxies value: ${raw}`);
}

function validateDataHeader(payload) {
  if (!isObject(payload)) {
    throw new Error("data is required");
  }
  if (payload.type && payload.type !== DATA_TYPE && payload.type !== LEGACY_DATA_TYPE) {
    throw new Error(`unsupported data type: ${payload.type}`);
  }
  if (payload.version != null && Number(payload.version) !== 0 && Number(payload.version) !== DATA_VERSION) {
    throw new Error(`unsupported data version: ${Number(payload.version)}`);
  }
  if (!Array.isArray(payload.proxies)) {
    throw new Error("proxies is required");
  }
  if (!Array.isArray(payload.accounts)) {
    throw new Error("accounts is required");
  }
}

function validateDataProxy(item) {
  const protocol = String(item.protocol || "").trim().toLowerCase();
  const host = String(item.host || "").trim();
  const port = Number(item.port);

  if (!protocol) throw new Error("proxy protocol is required");
  if (!host) throw new Error("proxy host is required");
  if (!Number.isFinite(port) || port <= 0 || port > 65535 || !Number.isInteger(port)) {
    throw new Error("proxy port is invalid");
  }
  if (!PROXY_PROTOCOLS.has(protocol)) {
    throw new Error(`proxy protocol is invalid: ${item.protocol}`);
  }

  if (item.status != null && String(item.status).trim() !== "") {
    const normalizedStatus = normalizeProxyStatus(item.status);
    if (!PROXY_STATUS.has(normalizedStatus)) {
      throw new Error(`proxy status is invalid: ${item.status}`);
    }
  }
}

function validateDataAccount(item) {
  const name = String(item.name || "").trim();
  const platform = String(item.platform || "").trim();
  const type = String(item.type || "").trim();

  if (!name) throw new Error("account name is required");
  if (!platform) throw new Error("account platform is required");
  if (!type) throw new Error("account type is required");
  if (!isObject(item.credentials) || Object.keys(item.credentials).length === 0) {
    throw new Error("account credentials is required");
  }
  if (!ACCOUNT_TYPES.has(type)) {
    throw new Error(`account type is invalid: ${type}`);
  }

  if (item.rate_multiplier != null) {
    const rate = Number(item.rate_multiplier);
    if (!Number.isFinite(rate) || rate < 0) {
      throw new Error("rate_multiplier must be >= 0");
    }
  }

  if (item.concurrency != null) {
    const concurrency = Number(item.concurrency);
    if (!Number.isFinite(concurrency) || concurrency < 0 || !Number.isInteger(concurrency)) {
      throw new Error("concurrency must be >= 0");
    }
  }

  if (item.priority != null) {
    const priority = Number(item.priority);
    if (!Number.isFinite(priority) || priority < 0 || !Number.isInteger(priority)) {
      throw new Error("priority must be >= 0");
    }
  }
}

function applyAccountFilters(list, filters) {
  const search = String(filters.search || "").trim().toLowerCase();
  const platform = String(filters.platform || "").trim().toLowerCase();
  const type = String(filters.type || "").trim().toLowerCase();
  const status = String(filters.status || "").trim().toLowerCase();

  return list.filter((item) => {
    if (platform && item.platform !== platform) return false;
    if (type && item.type !== type) return false;
    if (status && item.status !== status) return false;

    if (search) {
      const email = item.extra && typeof item.extra.email_address === "string" ? item.extra.email_address : "";
      const text = `${item.name} ${item.notes || ""} ${email}`.toLowerCase();
      if (!text.includes(search)) return false;
    }
    return true;
  });
}

function paginate(list, page, pageSize) {
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), pages);
  const start = (safePage - 1) * pageSize;
  const items = list.slice(start, start + pageSize);
  return {
    items,
    total,
    page: safePage,
    page_size: pageSize,
    pages
  };
}

function computeAccountsEtag(payload) {
  const hash = crypto.createHash("sha1").update(JSON.stringify(payload), "utf8").digest("hex");
  return `"${hash}"`;
}

async function handleGenerateAuthURL(req, res) {
  let body = {};
  try {
    body = await parseJSONBody(req);
  } catch (err) {
    writeJSON(res, 400, { detail: err.message });
    return;
  }

  const addMethod = String(body.add_method || "oauth").trim();
  const scope = addMethod === "setup-token" ? OAUTH.scopeInference : OAUTH.scopeOAuth;

  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const sessionID = generateSessionID();
  const authURL = buildAuthorizationURL({ state, codeChallenge, scope });

  sessions.set(sessionID, {
    state,
    codeVerifier,
    scope,
    createdAt: Date.now()
  });

  writeJSON(res, 200, {
    auth_url: authURL,
    session_id: sessionID
  });
}

async function handlePrepareExchange(req, res) {
  let body = {};
  try {
    body = await parseJSONBody(req);
  } catch (err) {
    writeJSON(res, 400, { detail: err.message });
    return;
  }

  const sessionID = String(body.session_id || "").trim();
  const code = String(body.code || "").trim();

  if (!sessionID || !code) {
    writeJSON(res, 400, { detail: "session_id and code are required" });
    return;
  }

  cleanupSessions();
  if (!sessions.has(sessionID)) {
    writeJSON(res, 400, { detail: "session not found or expired" });
    return;
  }

  writeJSON(res, 200, {
    session_id: sessionID,
    code
  });
}

async function handleListAccounts(req, res, reqURL) {
  const forceUsageRefresh = ["1", "true", "yes"].includes(
    String(reqURL.searchParams.get("force_usage") || "").toLowerCase()
  );
  if (forceUsageRefresh) {
    try {
      await runBackgroundRefreshCycle("list_force");
    } catch (err) {
      console.error("[claudetest] force usage refresh failed:", err);
    }
  }

  const page = toPositiveInt(reqURL.searchParams.get("page"), 1);
  const pageSize = Math.min(toPositiveInt(reqURL.searchParams.get("page_size"), 20), 200);

  const filtered = applyAccountFilters(accounts, {
    search: reqURL.searchParams.get("search") || "",
    platform: reqURL.searchParams.get("platform") || "",
    type: reqURL.searchParams.get("type") || "",
    status: reqURL.searchParams.get("status") || ""
  });

  const sorted = [...filtered].sort((a, b) => b.id - a.id);
  const paged = paginate(sorted, page, pageSize);
  const etag = computeAccountsEtag({
    page: paged.page,
    page_size: paged.page_size,
    total: paged.total,
    items: paged.items.map((item) => [
      item.id,
      item.updated_at,
      item.status,
      item.schedulable,
      item.current_concurrency,
      item.last_used_at,
      item.extra && item.extra.usage && item.extra.usage.updated_at
    ])
  });

  const ifNoneMatch = String(req.headers["if-none-match"] || "");
  if (ifNoneMatch && ifNoneMatch === etag) {
    writeNotModified(res, etag);
    return;
  }

  writeJSON(res, 200, paged, { ETag: etag });
}

function resolveExportAccounts(reqURL) {
  const selectedIDs = parseAccountIDs(reqURL);
  if (selectedIDs.length > 0) {
    const selectedSet = new Set(selectedIDs);
    return accounts.filter((item) => selectedSet.has(item.id));
  }
  return applyAccountFilters(accounts, {
    search: reqURL.searchParams.get("search") || "",
    platform: reqURL.searchParams.get("platform") || "",
    type: reqURL.searchParams.get("type") || "",
    status: reqURL.searchParams.get("status") || ""
  });
}

function resolveExportProxies(selectedAccounts) {
  const seen = new Set();
  const out = [];
  for (const account of selectedAccounts) {
    const proxyID = Number(account.proxy_id);
    if (!Number.isFinite(proxyID) || proxyID <= 0 || seen.has(proxyID)) continue;
    const proxy = proxies.find((item) => item.id === proxyID);
    if (!proxy) continue;
    seen.add(proxyID);
    out.push(proxy);
  }
  return out;
}

async function handleExportAccountsData(res, reqURL) {
  let selectedAccounts = [];
  let includeProxies = true;
  try {
    selectedAccounts = resolveExportAccounts(reqURL);
    includeProxies = parseIncludeProxies(reqURL);
  } catch (err) {
    writeJSON(res, 400, { detail: String(err.message || err) });
    return;
  }

  const selectedProxies = includeProxies ? resolveExportProxies(selectedAccounts) : [];
  const proxyKeyByID = new Map();
  const dataProxies = selectedProxies.map((proxy) => {
    const key = buildProxyKey(
      proxy.protocol,
      proxy.host,
      proxy.port,
      proxy.username || "",
      proxy.password || ""
    );
    proxyKeyByID.set(proxy.id, key);
    return {
      proxy_key: key,
      name: proxy.name,
      protocol: proxy.protocol,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username || "",
      password: proxy.password || "",
      status: proxy.status
    };
  });

  const dataAccounts = selectedAccounts.map((account) => {
    const out = {
      name: account.name,
      notes: account.notes,
      platform: account.platform,
      type: account.type,
      credentials: isObject(account.credentials) ? deepCloneJSON(account.credentials) : {},
      extra: isObject(account.extra) ? deepCloneJSON(account.extra) : {},
      concurrency: toNonNegativeInt(account.concurrency, 0),
      priority: toNonNegativeInt(account.priority, 0),
      auto_pause_on_expired: account.auto_pause_on_expired === true
    };

    if (account.rate_multiplier != null) {
      const rate = Number(account.rate_multiplier);
      if (Number.isFinite(rate)) {
        out.rate_multiplier = rate;
      }
    }
    if (account.expires_at != null) {
      const expiresAt = Number(account.expires_at);
      if (Number.isFinite(expiresAt)) {
        out.expires_at = Math.floor(expiresAt);
      }
    }
    if (account.proxy_id != null && proxyKeyByID.has(account.proxy_id)) {
      out.proxy_key = proxyKeyByID.get(account.proxy_id);
    }
    return out;
  });

  writeJSON(res, 200, {
    exported_at: nowISO(),
    proxies: dataProxies,
    accounts: dataAccounts
  });
}

async function handleImportAccountsData(req, res) {
  let body = {};
  try {
    body = await parseJSONBody(req);
  } catch (err) {
    writeJSON(res, 400, { detail: `Invalid request: ${err.message}` });
    return;
  }

  if (!isObject(body) || !isObject(body.data)) {
    writeJSON(res, 400, { detail: "Invalid request: data is required" });
    return;
  }

  const payload = body.data;
  try {
    validateDataHeader(payload);
  } catch (err) {
    writeJSON(res, 400, { detail: String(err.message || err) });
    return;
  }

  const result = {
    proxy_created: 0,
    proxy_reused: 0,
    proxy_failed: 0,
    account_created: 0,
    account_failed: 0,
    errors: []
  };

  const proxyKeyToID = new Map();
  for (const proxy of proxies) {
    const key = buildProxyKey(proxy.protocol, proxy.host, proxy.port, proxy.username, proxy.password);
    proxyKeyToID.set(key, proxy.id);
  }

  for (const item of payload.proxies) {
    const key =
      String(item.proxy_key || "").trim() ||
      buildProxyKey(item.protocol, item.host, item.port, item.username, item.password);
    try {
      validateDataProxy(item);
    } catch (err) {
      result.proxy_failed += 1;
      result.errors.push({
        kind: "proxy",
        name: String(item.name || ""),
        proxy_key: key,
        message: String(err.message || err)
      });
      continue;
    }

    const normalizedStatus = normalizeProxyStatus(item.status);
    if (proxyKeyToID.has(key)) {
      const proxyID = proxyKeyToID.get(key);
      result.proxy_reused += 1;
      if (normalizedStatus && PROXY_STATUS.has(normalizedStatus)) {
        const existing = proxies.find((entry) => entry.id === proxyID);
        if (existing && existing.status !== normalizedStatus) {
          existing.status = normalizedStatus;
          existing.updated_at = nowISO();
        }
      }
      continue;
    }

    try {
      const created = createProxyRecord({
        name: defaultProxyName(item.name),
        protocol: String(item.protocol || "").trim().toLowerCase(),
        host: String(item.host || "").trim(),
        port: Number(item.port),
        username: item.username == null ? "" : String(item.username),
        password: item.password == null ? "" : String(item.password),
        status: normalizedStatus || "active"
      });
      proxies.push(created);
      proxyKeyToID.set(key, created.id);
      result.proxy_created += 1;
    } catch (err) {
      result.proxy_failed += 1;
      result.errors.push({
        kind: "proxy",
        name: String(item.name || ""),
        proxy_key: key,
        message: String(err.message || err)
      });
    }
  }

  for (const item of payload.accounts) {
    try {
      validateDataAccount(item);
    } catch (err) {
      result.account_failed += 1;
      result.errors.push({
        kind: "account",
        name: String(item.name || ""),
        message: String(err.message || err)
      });
      continue;
    }

    let proxyID = null;
    const proxyKey = item.proxy_key == null ? "" : String(item.proxy_key).trim();
    if (proxyKey) {
      if (!proxyKeyToID.has(proxyKey)) {
        result.account_failed += 1;
        result.errors.push({
          kind: "account",
          name: String(item.name || ""),
          proxy_key: proxyKey,
          message: "proxy_key not found"
        });
        continue;
      }
      proxyID = proxyKeyToID.get(proxyKey);
    }

    try {
      const account = createAccountRecord({
        name: String(item.name || "").trim(),
        notes: item.notes == null ? null : String(item.notes),
        platform: String(item.platform || "").trim(),
        type: String(item.type || "").trim(),
        credentials: isObject(item.credentials) ? item.credentials : {},
        extra: isObject(item.extra) ? item.extra : {},
        proxy_id: proxyID,
        concurrency: item.concurrency == null ? 1 : Number(item.concurrency),
        priority: item.priority == null ? 1 : Number(item.priority),
        rate_multiplier: item.rate_multiplier == null ? 1 : Number(item.rate_multiplier),
        expires_at: item.expires_at == null ? null : Number(item.expires_at),
        auto_pause_on_expired: item.auto_pause_on_expired === true,
        status: "active",
        schedulable: true
      });
      accounts.push(account);
      result.account_created += 1;
    } catch (err) {
      result.account_failed += 1;
      result.errors.push({
        kind: "account",
        name: String(item.name || ""),
        message: String(err.message || err)
      });
    }
  }

  saveAccounts();
  if (result.errors.length === 0) {
    writeJSON(res, 200, {
      proxy_created: result.proxy_created,
      proxy_reused: result.proxy_reused,
      proxy_failed: result.proxy_failed,
      account_created: result.account_created,
      account_failed: result.account_failed
    });
    return;
  }

  writeJSON(res, 200, result);
}

async function handleCreateAccount(req, res) {
  let body = {};
  try {
    body = await parseJSONBody(req);
  } catch (err) {
    writeJSON(res, 400, { detail: err.message });
    return;
  }

  const name = String(body.name || "").trim();
  const platform = String(body.platform || "").trim().toLowerCase();
  const type = String(body.type || "").trim().toLowerCase();
  const status = String(body.status || "active").trim().toLowerCase();

  if (!name) {
    writeJSON(res, 400, { detail: "name is required" });
    return;
  }
  if (!PLATFORMS.has(platform)) {
    writeJSON(res, 400, { detail: "invalid platform" });
    return;
  }
  if (!ACCOUNT_TYPES.has(type)) {
    writeJSON(res, 400, { detail: "invalid type" });
    return;
  }
  if (!ACCOUNT_STATUS.has(status)) {
    writeJSON(res, 400, { detail: "invalid status" });
    return;
  }

  const account = createAccountRecord({
    name,
    notes: body.notes,
    platform,
    type,
    credentials: isObject(body.credentials) ? body.credentials : {},
    extra: isObject(body.extra) ? body.extra : {},
    proxy_id: body.proxy_id,
    concurrency: body.concurrency,
    priority: body.priority,
    rate_multiplier: body.rate_multiplier,
    status,
    expires_at: body.expires_at,
    auto_pause_on_expired: body.auto_pause_on_expired === true,
    schedulable: body.schedulable !== false
  });

  accounts.push(account);
  await refreshSingleAccountUsage(account);
  saveAccounts();

  writeJSON(res, 201, account);
}

async function handleCreateAccountFromAuthCode(req, res) {
  let body = {};
  try {
    body = await parseJSONBody(req);
  } catch (err) {
    writeJSON(res, 400, { detail: err.message });
    return;
  }

  const name = String(body.name || "").trim();
  const sessionID = String(body.session_id || "").trim();
  const code = String(body.code || "").trim();
  const platform = String(body.platform || "anthropic").trim().toLowerCase();
  const type = String(body.type || "oauth").trim().toLowerCase();

  if (!name) {
    writeJSON(res, 400, { detail: "name is required" });
    return;
  }
  if (platform !== "anthropic") {
    writeJSON(res, 400, { detail: "only anthropic platform supports auth-code flow in claudetest" });
    return;
  }
  if (type !== "oauth" && type !== "setup-token") {
    writeJSON(res, 400, { detail: "type must be oauth or setup-token" });
    return;
  }
  if (!sessionID || !code) {
    writeJSON(res, 400, { detail: "session_id and code are required" });
    return;
  }

  cleanupSessions();
  const session = sessions.get(sessionID);
  if (!session) {
    writeJSON(res, 400, { detail: "session not found or expired" });
    return;
  }

  const isSetupToken = session.scope === OAUTH.scopeInference || type === "setup-token";
  let tokenInfo = null;
  try {
    tokenInfo = await exchangeCodeForToken({
      codeInput: code,
      codeVerifier: session.codeVerifier,
      isSetupToken
    });
  } catch (err) {
    writeJSON(res, 400, { detail: String(err.message || err) });
    return;
  }
  sessions.delete(sessionID);

  const credentials = {
    access_token: tokenInfo.access_token,
    token_type: tokenInfo.token_type,
    expires_in: tokenInfo.expires_in,
    expires_at: tokenInfo.expires_at,
    refresh_token: tokenInfo.refresh_token,
    scope: tokenInfo.scope
  };

  const extra = {};
  if (tokenInfo.org_uuid) extra.org_uuid = tokenInfo.org_uuid;
  if (tokenInfo.account_uuid) extra.account_uuid = tokenInfo.account_uuid;
  if (tokenInfo.email_address) extra.email_address = tokenInfo.email_address;

  const account = createAccountRecord({
    name,
    notes: body.notes,
    platform,
    type,
    credentials,
    extra,
    proxy_id: body.proxy_id,
    concurrency: body.concurrency,
    priority: body.priority,
    rate_multiplier: body.rate_multiplier,
    status: "active",
    schedulable: body.schedulable !== false
  });

  accounts.push(account);
  saveAccounts();

  writeJSON(res, 201, {
    account,
    token_info: tokenInfo
  });
}

async function handleRefreshAllUsage(res) {
  try {
    const result = await runBackgroundRefreshCycle("manual_api");
    writeJSON(res, 200, result);
  } catch (err) {
    writeJSON(res, 500, { detail: String(err.message || err) });
  }
}

function buildBackgroundRefreshStatus() {
  const nextRunAt = backgroundRefresh.next_run_at;
  let nextRunInSeconds = null;
  if (nextRunAt) {
    const diff = Math.ceil((new Date(nextRunAt).getTime() - Date.now()) / 1000);
    nextRunInSeconds = diff > 0 ? diff : 0;
  }

  return {
    enabled: backgroundRefresh.enabled,
    interval_seconds: backgroundRefresh.interval_seconds,
    allowed_intervals: BACKGROUND_REFRESH_ALLOWED_INTERVALS,
    running: backgroundRefresh.running,
    next_run_at: nextRunAt,
    next_run_in_seconds: nextRunInSeconds,
    last_started_at: backgroundRefresh.last_started_at,
    last_finished_at: backgroundRefresh.last_finished_at,
    last_error: backgroundRefresh.last_error,
    last_result: backgroundRefresh.last_result,
    task_enabled: backgroundRefresh.task_enabled,
    task_content: backgroundRefresh.task_content
  };
}

function handleGetBackgroundRefreshStatus(res) {
  writeJSON(res, 200, buildBackgroundRefreshStatus());
}

async function handleUpdateBackgroundRefreshConfig(req, res) {
  let body = {};
  try {
    body = await parseJSONBody(req);
  } catch (err) {
    writeJSON(res, 400, { detail: err.message });
    return;
  }

  try {
    applyBackgroundRefreshConfig({
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      interval_seconds:
        body.interval_seconds == null ? undefined : Number(body.interval_seconds),
      task_enabled: typeof body.task_enabled === "boolean" ? body.task_enabled : undefined,
      task_content: typeof body.task_content === "string" ? body.task_content : undefined
    });
  } catch (err) {
    writeJSON(res, 400, { detail: String(err.message || err) });
    return;
  }

  writeJSON(res, 200, buildBackgroundRefreshStatus());
}

async function handleRunBackgroundRefreshNow(res) {
  try {
    const result = await runBackgroundRefreshCycle("run_now_api");
    writeJSON(res, 200, {
      status: buildBackgroundRefreshStatus(),
      result
    });
  } catch (err) {
    writeJSON(res, 500, { detail: String(err.message || err) });
  }
}

async function handleSetSchedulable(req, res, accountID) {
  let body = {};
  try {
    body = await parseJSONBody(req);
  } catch (err) {
    writeJSON(res, 400, { detail: err.message });
    return;
  }

  const account = accounts.find((item) => item.id === accountID);
  if (!account) {
    writeJSON(res, 404, { detail: "account not found" });
    return;
  }

  account.schedulable = body.schedulable !== false;
  account.updated_at = nowISO();
  saveAccounts();
  writeJSON(res, 200, account);
}

async function handleDeleteAccount(res, accountID) {
  const index = accounts.findIndex((item) => item.id === accountID);
  if (index < 0) {
    writeJSON(res, 404, { detail: "account not found" });
    return;
  }
  accounts.splice(index, 1);
  saveAccounts();
  writeJSON(res, 200, { message: "deleted" });
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

function serveStatic(reqPath, res) {
  const normalized = reqPath === "/" ? "/index.html" : reqPath;
  const relative = path.normalize(normalized).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(FRONTEND_DIR, relative);

  if (!filePath.startsWith(FRONTEND_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === "ENOENT") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal Server Error");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

loadAccounts();
loadBackgroundRefreshConfig();
startBackgroundRefreshTicker();

const server = http.createServer(async (req, res) => {
  const reqURL = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    writeNoContent(res);
    return;
  }

  if (reqURL.pathname === "/api/health" && req.method === "GET") {
    writeJSON(res, 200, {
      status: "ok",
      sessions: sessions.size,
      accounts: accounts.length,
      background_refresh_enabled: backgroundRefresh.enabled,
      background_refresh_running: backgroundRefresh.running
    });
    return;
  }

  if (reqURL.pathname === "/api/background-refresh/status" && req.method === "GET") {
    handleGetBackgroundRefreshStatus(res);
    return;
  }

  if (reqURL.pathname === "/api/background-refresh/config" && req.method === "POST") {
    await handleUpdateBackgroundRefreshConfig(req, res);
    return;
  }

  if (reqURL.pathname === "/api/background-refresh/run-now" && req.method === "POST") {
    await handleRunBackgroundRefreshNow(res);
    return;
  }

  if (reqURL.pathname === "/api/accounts" && req.method === "GET") {
    await handleListAccounts(req, res, reqURL);
    return;
  }

  if (reqURL.pathname === "/api/accounts/data" && req.method === "GET") {
    await handleExportAccountsData(res, reqURL);
    return;
  }

  if (reqURL.pathname === "/api/accounts/data" && req.method === "POST") {
    await handleImportAccountsData(req, res);
    return;
  }

  if (reqURL.pathname === "/api/accounts" && req.method === "POST") {
    await handleCreateAccount(req, res);
    return;
  }

  if (reqURL.pathname === "/api/accounts/from-auth-code" && req.method === "POST") {
    await handleCreateAccountFromAuthCode(req, res);
    return;
  }

  if (reqURL.pathname === "/api/accounts/refresh-usage" && req.method === "POST") {
    await handleRefreshAllUsage(res);
    return;
  }

  const schedulableMatch = reqURL.pathname.match(/^\/api\/accounts\/(\d+)\/schedulable$/);
  if (schedulableMatch && req.method === "POST") {
    await handleSetSchedulable(req, res, Number(schedulableMatch[1]));
    return;
  }

  const deleteMatch = reqURL.pathname.match(/^\/api\/accounts\/(\d+)$/);
  if (deleteMatch && req.method === "DELETE") {
    await handleDeleteAccount(res, Number(deleteMatch[1]));
    return;
  }

  if (reqURL.pathname === "/api/generate-auth-url" && req.method === "POST") {
    await handleGenerateAuthURL(req, res);
    return;
  }

  if (reqURL.pathname === "/api/prepare-exchange" && req.method === "POST") {
    await handlePrepareExchange(req, res);
    return;
  }

  if (req.method === "GET") {
    serveStatic(reqURL.pathname, res);
    return;
  }

  writeJSON(res, 404, { detail: "not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`claudetest server running at http://${HOST}:${PORT}`);
});
