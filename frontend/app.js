"use strict";

const AUTO_REFRESH_STORAGE_KEY = "claudetest.account.auto_refresh";
const AUTO_REFRESH_INTERVALS = [5, 10, 15, 30];

const state = {
  loading: false,
  refreshingUsage: false,
  accounts: [],
  pagination: {
    page: 1,
    pageSize: 20,
    pages: 1,
    total: 0
  },
  filters: {
    search: "",
    platform: "",
    type: "",
    status: ""
  },
  autoRefresh: {
    enabled: false,
    interval: 30,
    countdown: 0
  },
  backgroundRefresh: {
    enabled: false,
    interval_seconds: 60,
    allowed_intervals: [1, 10, 30, 60, 120, 300],
    running: false,
    next_run_at: null,
    next_run_in_seconds: null,
    last_started_at: null,
    last_finished_at: null,
    last_error: null,
    last_result: null
  },
  oauthCreate: {
    authUrl: "",
    sessionId: ""
  }
};

const els = {
  searchInput: document.getElementById("search-input"),
  platformFilter: document.getElementById("platform-filter"),
  typeFilter: document.getElementById("type-filter"),
  statusFilter: document.getElementById("status-filter"),
  btnRefresh: document.getElementById("btn-refresh"),
  btnExportData: document.getElementById("btn-export-data"),
  btnImportData: document.getElementById("btn-import-data"),
  importFileInput: document.getElementById("import-file-input"),
  autoRefreshWrap: document.getElementById("auto-refresh-wrap"),
  btnAutoRefresh: document.getElementById("btn-auto-refresh"),
  autoRefreshLabel: document.getElementById("auto-refresh-label"),
  autoRefreshDropdown: document.getElementById("auto-refresh-dropdown"),
  autoRefreshEnabled: document.getElementById("auto-refresh-enabled"),
  intervalOptions: document.getElementById("interval-options"),
  bgRefreshEnabled: document.getElementById("bg-refresh-enabled"),
  bgRefreshInterval: document.getElementById("bg-refresh-interval"),
  btnBgRefreshSave: document.getElementById("btn-bg-refresh-save"),
  btnBgRefreshRun: document.getElementById("btn-bg-refresh-run"),
  bgRefreshStatusBadge: document.getElementById("bg-refresh-status-badge"),
  bgRefreshRunning: document.getElementById("bg-refresh-running"),
  bgRefreshNextRun: document.getElementById("bg-refresh-next-run"),
  bgRefreshLastStart: document.getElementById("bg-refresh-last-start"),
  bgRefreshLastFinish: document.getElementById("bg-refresh-last-finish"),
  bgRefreshLastResult: document.getElementById("bg-refresh-last-result"),
  btnCreate: document.getElementById("btn-create"),
  tbody: document.getElementById("accounts-tbody"),
  summaryText: document.getElementById("summary-text"),
  pageText: document.getElementById("page-text"),
  btnPrevPage: document.getElementById("btn-prev-page"),
  btnNextPage: document.getElementById("btn-next-page"),
  errorBox: document.getElementById("error-box"),
  successBox: document.getElementById("success-box"),
  modalMask: document.getElementById("modal-mask"),
  btnCloseModal: document.getElementById("btn-close-modal"),
  btnCancelModal: document.getElementById("btn-cancel-modal"),
  createForm: document.getElementById("create-form"),
  formName: document.getElementById("form-name"),
  formNotes: document.getElementById("form-notes"),
  formPlatform: document.getElementById("form-platform"),
  formType: document.getElementById("form-type"),
  formStatus: document.getElementById("form-status"),
  formConcurrency: document.getElementById("form-concurrency"),
  formPriority: document.getElementById("form-priority"),
  formRateMultiplier: document.getElementById("form-rate-multiplier"),
  formSchedulable: document.getElementById("form-schedulable"),
  formCredentials: document.getElementById("form-credentials"),
  oauthCreateSection: document.getElementById("oauth-create-section"),
  oauthCreateEnabled: document.getElementById("oauth-create-enabled"),
  oauthCreateBody: document.getElementById("oauth-create-body"),
  manualCredentialsSection: document.getElementById("manual-credentials-section"),
  btnGenerateUrl: document.getElementById("btn-generate-url"),
  oauthUrlBox: document.getElementById("oauth-url-box"),
  oauthAuthUrl: document.getElementById("oauth-auth-url"),
  btnCopyUrl: document.getElementById("btn-copy-url"),
  btnOpenUrl: document.getElementById("btn-open-url"),
  oauthSessionId: document.getElementById("oauth-session-id"),
  oauthAuthCode: document.getElementById("oauth-auth-code"),
  btnSubmitCreate: document.getElementById("btn-submit-create")
};

function escapeHTML(input) {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function debounce(fn, waitMs) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}

function showError(message) {
  if (!message) {
    els.errorBox.classList.add("hidden");
    els.errorBox.textContent = "";
    return;
  }
  els.errorBox.textContent = message;
  els.errorBox.classList.remove("hidden");
}

function showSuccess(message) {
  if (!message) {
    els.successBox.classList.add("hidden");
    els.successBox.textContent = "";
    return;
  }
  els.successBox.textContent = message;
  els.successBox.classList.remove("hidden");
}

function clearMessages() {
  showError("");
  showSuccess("");
}

function formatDateTime(iso) {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "-";
    return d.toLocaleString("zh-CN", { hour12: false });
  } catch {
    return "-";
  }
}

function formatRelativeTime(iso) {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
    if (Number.isNaN(diffSec)) return "-";
    if (diffSec < 60) return `${diffSec}s 前`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m 前`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h 前`;
    return `${Math.floor(diffSec / 86400)}d 前`;
  } catch {
    return "-";
  }
}

function updateLoadingState(loading) {
  state.loading = loading;
  els.btnRefresh.disabled = loading || state.refreshingUsage;
  els.btnExportData.disabled = loading || state.refreshingUsage;
  els.btnImportData.disabled = loading || state.refreshingUsage;
  els.btnPrevPage.disabled = loading || state.pagination.page <= 1;
  els.btnNextPage.disabled = loading || state.pagination.page >= state.pagination.pages;
}

function setRefreshingUsage(refreshing) {
  state.refreshingUsage = refreshing;
  els.btnRefresh.disabled = refreshing || state.loading;
  els.btnExportData.disabled = refreshing || state.loading;
  els.btnImportData.disabled = refreshing || state.loading;
}

async function request(method, url, payload) {
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json"
    },
    body: payload == null ? undefined : JSON.stringify(payload)
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!response.ok) {
    throw new Error(data.detail || `请求失败: ${response.status}`);
  }
  return data;
}

function currentQueryString() {
  const params = new URLSearchParams();
  params.set("page", String(state.pagination.page));
  params.set("page_size", String(state.pagination.pageSize));
  if (state.filters.search) params.set("search", state.filters.search);
  if (state.filters.platform) params.set("platform", state.filters.platform);
  if (state.filters.type) params.set("type", state.filters.type);
  if (state.filters.status) params.set("status", state.filters.status);
  return params.toString();
}

function currentExportQueryString() {
  const params = new URLSearchParams();
  if (state.filters.search) params.set("search", state.filters.search);
  if (state.filters.platform) params.set("platform", state.filters.platform);
  if (state.filters.type) params.set("type", state.filters.type);
  if (state.filters.status) params.set("status", state.filters.status);
  params.set("include_proxies", "true");
  return params.toString();
}

function formatExportTimestamp() {
  const now = new Date();
  const pad2 = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}${pad2(
    now.getHours()
  )}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
}

function downloadJSON(filename, data) {
  const text = JSON.stringify(data, null, 2);
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function readFileAsText(file) {
  if (typeof file.text === "function") {
    return file.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("failed to read file"));
    reader.readAsText(file);
  });
}

function renderUsageCell(account) {
  const extra = account.extra && typeof account.extra === "object" ? account.extra : {};
  const usage = extra.usage && typeof extra.usage === "object" ? extra.usage : null;
  const err = typeof extra.usage_error === "string" ? extra.usage_error : "";

  if (!usage && !err) {
    return '<div class="usage-cell"><div class="usage-line">-</div></div>';
  }

  const lines = [];
  if (usage && usage.five_hour) {
    const f = usage.five_hour;
    lines.push(
      `<div class="usage-line">5h: ${Number(f.utilization || 0).toFixed(1)}%` +
        (f.resets_at ? ` / reset ${escapeHTML(formatDateTime(f.resets_at))}` : "") +
        "</div>"
    );
  }
  if (usage && usage.seven_day) {
    const s = usage.seven_day;
    lines.push(
      `<div class="usage-line">7d: ${Number(s.utilization || 0).toFixed(1)}%` +
        (s.resets_at ? ` / reset ${escapeHTML(formatDateTime(s.resets_at))}` : "") +
        "</div>"
    );
  }
  if (err) {
    lines.push(`<div class="usage-error" title="${escapeHTML(err)}">ERR: ${escapeHTML(err)}</div>`);
  }
  return `<div class="usage-cell">${lines.join("")}</div>`;
}

function renderRows() {
  if (state.loading && state.accounts.length === 0) {
    els.tbody.innerHTML = '<tr><td colspan="11" class="empty-cell">加载中...</td></tr>';
    return;
  }

  if (state.accounts.length === 0) {
    els.tbody.innerHTML = '<tr><td colspan="11" class="empty-cell">暂无账号</td></tr>';
    return;
  }

  const html = state.accounts
    .map((account) => {
      const extra = account.extra && typeof account.extra === "object" ? account.extra : {};
      const email = typeof extra.email_address === "string" ? extra.email_address : "";
      const platform = escapeHTML(account.platform || "-");
      const type = escapeHTML(account.type || "-");
      const status = escapeHTML(account.status || "-");
      const statusClass = `status-${status}`.replace(/[^a-z0-9-_]/gi, "");
      const schedClass = account.schedulable ? "bool-yes" : "bool-no";
      const schedText = account.schedulable ? "是" : "否";

      return (
        "<tr>" +
        "<td>" +
        `<div class="name-main">${escapeHTML(account.name || "-")}</div>` +
        (email ? `<div class="name-sub" title="${escapeHTML(email)}">${escapeHTML(email)}</div>` : "") +
        "</td>" +
        "<td>" +
        `<span class="badge platform">${platform}</span> ` +
        `<span class="badge type">${type}</span>` +
        "</td>" +
        `<td><span class="badge ${statusClass}">${status}</span></td>` +
        `<td><span class="${schedClass}">${schedText}</span></td>` +
        `<td>${Number(account.concurrency || 0)}</td>` +
        `<td>${Number(account.priority || 0)}</td>` +
        `<td>${Number(account.rate_multiplier || 0).toFixed(2)}x</td>` +
        `<td>${renderUsageCell(account)}</td>` +
        `<td>${escapeHTML(formatRelativeTime(account.last_used_at))}</td>` +
        `<td>${escapeHTML(formatDateTime(account.updated_at))}</td>` +
        "<td>" +
        `<div class="row-actions"><button class="btn btn-danger btn-sm btn-delete-account" data-id="${account.id}" data-name="${escapeHTML(account.name || "")}">删除</button></div>` +
        "</td>" +
        "</tr>"
      );
    })
    .join("");

  els.tbody.innerHTML = html;
}

function renderSummary() {
  els.summaryText.textContent = `共 ${state.pagination.total} 条，当前第 ${state.pagination.page}/${state.pagination.pages} 页`;
  els.pageText.textContent = `${state.pagination.page} / ${state.pagination.pages}`;
  els.btnPrevPage.disabled = state.loading || state.pagination.page <= 1;
  els.btnNextPage.disabled = state.loading || state.pagination.page >= state.pagination.pages;
}

function renderAutoRefreshLabel() {
  if (state.autoRefresh.enabled) {
    els.autoRefreshLabel.textContent = `自动刷新 (${state.autoRefresh.countdown}s)`;
  } else {
    els.autoRefreshLabel.textContent = "自动刷新";
  }
}

function renderIntervalOptions() {
  const buttons = els.intervalOptions.querySelectorAll(".interval-btn");
  buttons.forEach((btn) => {
    const sec = Number(btn.getAttribute("data-sec") || "0");
    if (sec === state.autoRefresh.interval) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });
}

function renderBackgroundRefreshIntervalOptions() {
  const options = state.backgroundRefresh.allowed_intervals || [];
  const current = Number(state.backgroundRefresh.interval_seconds || 60);

  const html = options
    .map((sec) => `<option value="${sec}">${sec}s</option>`)
    .join("");
  els.bgRefreshInterval.innerHTML = html;
  els.bgRefreshInterval.value = String(current);
}

function formatNextRunText(nextRunAt, nextRunInSeconds) {
  if (!nextRunAt) return "-";
  const when = formatDateTime(nextRunAt);
  if (nextRunInSeconds == null) return when;
  return `${when} (${Math.max(0, Number(nextRunInSeconds || 0))}s)`;
}

function renderBackgroundRefreshStatus() {
  const s = state.backgroundRefresh;

  els.bgRefreshEnabled.checked = s.enabled === true;
  renderBackgroundRefreshIntervalOptions();

  els.bgRefreshStatusBadge.textContent = s.enabled ? "已开启" : "已关闭";
  els.bgRefreshStatusBadge.className = `badge ${s.enabled ? "status-active" : "status-inactive"}`;

  if (s.running) {
    els.bgRefreshRunning.textContent = "运行中";
    els.bgRefreshRunning.className = "badge status-running";
  } else {
    els.bgRefreshRunning.textContent = "空闲";
    els.bgRefreshRunning.className = "";
  }
  els.btnBgRefreshRun.disabled = s.running;

  els.bgRefreshNextRun.textContent = formatNextRunText(s.next_run_at, s.next_run_in_seconds);
  els.bgRefreshLastStart.textContent = formatDateTime(s.last_started_at);
  els.bgRefreshLastFinish.textContent = formatDateTime(s.last_finished_at);

  if (s.last_error) {
    els.bgRefreshLastResult.textContent = `失败: ${s.last_error}`;
    els.bgRefreshLastResult.className = "usage-error";
  } else if (s.last_result && typeof s.last_result === "object") {
    const result = s.last_result;
    if (typeof result.refreshed === "number" && typeof result.total === "number") {
      els.bgRefreshLastResult.textContent =
        `${result.source || "unknown"}: ${result.refreshed}/${result.total} 成功`;
      els.bgRefreshLastResult.className = "";
    } else if (result.error) {
      els.bgRefreshLastResult.textContent = `失败: ${result.error}`;
      els.bgRefreshLastResult.className = "usage-error";
    } else {
      els.bgRefreshLastResult.textContent = "-";
      els.bgRefreshLastResult.className = "";
    }
  } else {
    els.bgRefreshLastResult.textContent = "-";
    els.bgRefreshLastResult.className = "";
  }
}

function persistAutoRefreshSettings() {
  localStorage.setItem(
    AUTO_REFRESH_STORAGE_KEY,
    JSON.stringify({
      enabled: state.autoRefresh.enabled,
      interval: state.autoRefresh.interval
    })
  );
}

function loadAutoRefreshSettings() {
  try {
    const raw = localStorage.getItem(AUTO_REFRESH_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    state.autoRefresh.enabled = parsed.enabled === true;
    if (AUTO_REFRESH_INTERVALS.includes(Number(parsed.interval))) {
      state.autoRefresh.interval = Number(parsed.interval);
    }
  } catch {
    // ignore
  }
  state.autoRefresh.countdown = state.autoRefresh.interval;
  els.autoRefreshEnabled.checked = state.autoRefresh.enabled;
  renderAutoRefreshLabel();
  renderIntervalOptions();
}

async function fetchBackgroundRefreshStatus(silent) {
  try {
    const data = await request("GET", "/api/background-refresh/status");
    state.backgroundRefresh.enabled = data.enabled === true;
    state.backgroundRefresh.interval_seconds = Number(data.interval_seconds || 60);
    state.backgroundRefresh.allowed_intervals = Array.isArray(data.allowed_intervals)
      ? data.allowed_intervals.map((v) => Number(v)).filter((v) => Number.isFinite(v))
      : [10, 30, 60, 120, 300];
    state.backgroundRefresh.running = data.running === true;
    state.backgroundRefresh.next_run_at = data.next_run_at || null;
    state.backgroundRefresh.next_run_in_seconds =
      data.next_run_in_seconds == null ? null : Number(data.next_run_in_seconds);
    state.backgroundRefresh.last_started_at = data.last_started_at || null;
    state.backgroundRefresh.last_finished_at = data.last_finished_at || null;
    state.backgroundRefresh.last_error = data.last_error || null;
    state.backgroundRefresh.last_result = data.last_result || null;
    renderBackgroundRefreshStatus();
  } catch (err) {
    if (!silent) {
      showError(String(err.message || err));
    }
  }
}

async function saveBackgroundRefreshConfig() {
  clearMessages();
  try {
    const enabled = els.bgRefreshEnabled.checked;
    const interval = Number(els.bgRefreshInterval.value || "60");
    const data = await request("POST", "/api/background-refresh/config", {
      enabled,
      interval_seconds: interval
    });
    state.backgroundRefresh.enabled = data.enabled === true;
    state.backgroundRefresh.interval_seconds = Number(data.interval_seconds || interval);
    state.backgroundRefresh.allowed_intervals = Array.isArray(data.allowed_intervals)
      ? data.allowed_intervals.map((v) => Number(v)).filter((v) => Number.isFinite(v))
      : state.backgroundRefresh.allowed_intervals;
    state.backgroundRefresh.running = data.running === true;
    state.backgroundRefresh.next_run_at = data.next_run_at || null;
    state.backgroundRefresh.next_run_in_seconds =
      data.next_run_in_seconds == null ? null : Number(data.next_run_in_seconds);
    state.backgroundRefresh.last_started_at = data.last_started_at || null;
    state.backgroundRefresh.last_finished_at = data.last_finished_at || null;
    state.backgroundRefresh.last_error = data.last_error || null;
    state.backgroundRefresh.last_result = data.last_result || null;
    renderBackgroundRefreshStatus();
    showSuccess("后台刷新配置已保存");
  } catch (err) {
    showError(String(err.message || err));
  }
}

async function runBackgroundRefreshNow() {
  clearMessages();
  els.btnBgRefreshRun.disabled = true;
  try {
    const data = await request("POST", "/api/background-refresh/run-now", {});
    if (data.status) {
      const status = data.status;
      state.backgroundRefresh.enabled = status.enabled === true;
      state.backgroundRefresh.interval_seconds = Number(status.interval_seconds || 60);
      state.backgroundRefresh.allowed_intervals = Array.isArray(status.allowed_intervals)
        ? status.allowed_intervals.map((v) => Number(v)).filter((v) => Number.isFinite(v))
        : state.backgroundRefresh.allowed_intervals;
      state.backgroundRefresh.running = status.running === true;
      state.backgroundRefresh.next_run_at = status.next_run_at || null;
      state.backgroundRefresh.next_run_in_seconds =
        status.next_run_in_seconds == null ? null : Number(status.next_run_in_seconds);
      state.backgroundRefresh.last_started_at = status.last_started_at || null;
      state.backgroundRefresh.last_finished_at = status.last_finished_at || null;
      state.backgroundRefresh.last_error = status.last_error || null;
      state.backgroundRefresh.last_result = status.last_result || null;
      renderBackgroundRefreshStatus();
    }
    if (data.result && typeof data.result.refreshed === "number") {
      showSuccess(`后台刷新完成：${data.result.refreshed}/${data.result.total} 成功`);
    } else {
      showSuccess("后台刷新已执行");
    }
    await loadAccounts();
  } catch (err) {
    showError(String(err.message || err));
  } finally {
    els.btnBgRefreshRun.disabled = false;
  }
}

function startBackgroundRefreshStatusPolling() {
  setInterval(() => {
    fetchBackgroundRefreshStatus(true);
  }, 5000);
}

async function loadAccounts() {
  updateLoadingState(true);
  try {
    const data = await request("GET", `/api/accounts?${currentQueryString()}`);
    state.accounts = Array.isArray(data.items) ? data.items : [];
    state.pagination.total = Number(data.total || 0);
    state.pagination.page = Number(data.page || 1);
    state.pagination.pageSize = Number(data.page_size || state.pagination.pageSize);
    state.pagination.pages = Number(data.pages || 1);
    renderRows();
    renderSummary();
  } catch (err) {
    showError(String(err.message || err));
  } finally {
    updateLoadingState(false);
  }
}

async function exportAccountsData() {
  clearMessages();
  els.btnExportData.disabled = true;
  try {
    const query = currentExportQueryString();
    const data = await request("GET", `/api/accounts/data?${query}`);
    const filename = `sub2api-account-${formatExportTimestamp()}.json`;
    downloadJSON(filename, data);
    showSuccess("数据导出成功");
  } catch (err) {
    showError(String(err.message || err));
  } finally {
    els.btnExportData.disabled = state.loading || state.refreshingUsage;
  }
}

async function importAccountsDataFromFile(file) {
  clearMessages();
  els.btnImportData.disabled = true;
  try {
    const text = await readFileAsText(file);
    const dataPayload = JSON.parse(text);
    const result = await request("POST", "/api/accounts/data", {
      data: dataPayload,
      skip_default_group_bind: true
    });

    const summary =
      `导入完成：账号新增 ${Number(result.account_created || 0)}，` +
      `账号失败 ${Number(result.account_failed || 0)}，` +
      `代理新增 ${Number(result.proxy_created || 0)}，` +
      `代理复用 ${Number(result.proxy_reused || 0)}，` +
      `代理失败 ${Number(result.proxy_failed || 0)}`;

    showSuccess(summary);

    const errors = Array.isArray(result.errors) ? result.errors : [];
    if (errors.length > 0) {
      const first = errors[0];
      const firstDetail = `${first.kind || "unknown"} ${first.name || first.proxy_key || "-"}: ${
        first.message || "-"
      }`;
      showError(`导入包含错误（${errors.length} 条）。首条：${firstDetail}`);
    }

    await loadAccounts();
  } catch (err) {
    if (err instanceof SyntaxError) {
      showError("导入文件解析失败，请检查 JSON 格式");
    } else {
      showError(String(err.message || err));
    }
  } finally {
    els.btnImportData.disabled = state.loading || state.refreshingUsage;
    els.importFileInput.value = "";
  }
}

async function deleteAccount(accountID, accountName) {
  const ok = window.confirm(`确认删除账号「${accountName || accountID}」吗？`);
  if (!ok) return;

  clearMessages();
  try {
    await request("DELETE", `/api/accounts/${accountID}`);
    showSuccess(`账号已删除：${accountName || accountID}`);

    await loadAccounts();
    if (state.accounts.length === 0 && state.pagination.page > 1) {
      state.pagination.page -= 1;
      await loadAccounts();
    }
  } catch (err) {
    showError(String(err.message || err));
  }
}

async function refreshUsageAndReload(reason) {
  if (state.refreshingUsage) return;
  setRefreshingUsage(true);
  try {
    const usageResult = await request("POST", "/api/accounts/refresh-usage", {});
    await loadAccounts();
    await fetchBackgroundRefreshStatus(true);
    if (reason === "manual") {
      showSuccess(`已刷新：${usageResult.refreshed}/${usageResult.total} 个账号用量`);
    }
  } catch (err) {
    showError(String(err.message || err));
  } finally {
    setRefreshingUsage(false);
  }
}

function updateFilterStateFromUI() {
  state.filters.search = els.searchInput.value.trim();
  state.filters.platform = els.platformFilter.value;
  state.filters.type = els.typeFilter.value;
  state.filters.status = els.statusFilter.value;
  state.pagination.page = 1;
}

function isOauthCreateMode() {
  const platform = els.formPlatform.value;
  const type = els.formType.value;
  return platform === "anthropic" && (type === "oauth" || type === "setup-token");
}

function syncCreateModeUI() {
  const oauthMode = isOauthCreateMode();
  if (oauthMode) {
    els.oauthCreateSection.classList.remove("hidden");
  } else {
    els.oauthCreateSection.classList.add("hidden");
    els.oauthCreateEnabled.checked = false;
  }

  if (oauthMode && els.oauthCreateEnabled.checked) {
    els.oauthCreateBody.classList.remove("hidden");
    els.manualCredentialsSection.classList.add("hidden");
  } else {
    els.oauthCreateBody.classList.add("hidden");
    els.manualCredentialsSection.classList.remove("hidden");
  }
}

function resetCreateModalState() {
  state.oauthCreate.authUrl = "";
  state.oauthCreate.sessionId = "";
  els.oauthAuthUrl.value = "";
  els.oauthSessionId.textContent = "-";
  els.oauthAuthCode.value = "";
  els.oauthUrlBox.classList.add("hidden");
}

function openCreateModal() {
  clearMessages();
  resetCreateModalState();
  els.formName.value = "";
  els.formNotes.value = "";
  els.formPlatform.value = "anthropic";
  els.formType.value = "oauth";
  els.formStatus.value = "active";
  els.formConcurrency.value = "1";
  els.formPriority.value = "1";
  els.formRateMultiplier.value = "1";
  els.formSchedulable.checked = true;
  els.formCredentials.value = "";
  els.oauthCreateEnabled.checked = true;
  syncCreateModeUI();
  els.modalMask.classList.remove("hidden");
}

function closeCreateModal() {
  els.modalMask.classList.add("hidden");
}

function extractCode(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  if (!raw.includes("code=")) return raw;
  try {
    const url = new URL(raw);
    return url.searchParams.get("code") || raw;
  } catch {
    const match = raw.match(/[?&]code=([^&]+)/);
    return match && match[1] ? decodeURIComponent(match[1]) : raw;
  }
}

async function generateOauthURL() {
  clearMessages();
  try {
    const addMethod = els.formType.value === "setup-token" ? "setup-token" : "oauth";
    const result = await request("POST", "/api/generate-auth-url", { add_method: addMethod });
    state.oauthCreate.authUrl = result.auth_url || "";
    state.oauthCreate.sessionId = result.session_id || "";
    els.oauthAuthUrl.value = state.oauthCreate.authUrl;
    els.oauthSessionId.textContent = state.oauthCreate.sessionId || "-";
    els.oauthUrlBox.classList.remove("hidden");
    showSuccess("授权 URL 已生成。");
  } catch (err) {
    showError(String(err.message || err));
  }
}

async function handleCreateSubmit(event) {
  event.preventDefault();
  clearMessages();

  const payloadBase = {
    name: els.formName.value.trim(),
    notes: els.formNotes.value.trim() || null,
    platform: els.formPlatform.value,
    type: els.formType.value,
    status: els.formStatus.value,
    concurrency: Number(els.formConcurrency.value || 1),
    priority: Number(els.formPriority.value || 1),
    rate_multiplier: Number(els.formRateMultiplier.value || 1),
    schedulable: els.formSchedulable.checked
  };

  if (!payloadBase.name) {
    showError("账号名称不能为空");
    return;
  }

  els.btnSubmitCreate.disabled = true;
  try {
    if (isOauthCreateMode() && els.oauthCreateEnabled.checked) {
      const code = extractCode(els.oauthAuthCode.value);
      const sessionID = state.oauthCreate.sessionId;
      if (!sessionID || !code) {
        throw new Error("请先生成授权 URL，并填写授权码");
      }
      await request("POST", "/api/accounts/from-auth-code", {
        ...payloadBase,
        session_id: sessionID,
        code
      });
    } else {
      let credentials = {};
      const rawCredentials = els.formCredentials.value.trim();
      if (rawCredentials) {
        try {
          credentials = JSON.parse(rawCredentials);
        } catch {
          throw new Error("credentials 不是合法 JSON");
        }
      }

      await request("POST", "/api/accounts", {
        ...payloadBase,
        credentials
      });
    }

    closeCreateModal();
    showSuccess("账号创建成功");
    await loadAccounts();
  } catch (err) {
    showError(String(err.message || err));
  } finally {
    els.btnSubmitCreate.disabled = false;
  }
}

function bindEvents() {
  const debouncedSearch = debounce(() => {
    updateFilterStateFromUI();
    loadAccounts();
  }, 300);

  els.searchInput.addEventListener("input", debouncedSearch);
  els.platformFilter.addEventListener("change", () => {
    updateFilterStateFromUI();
    loadAccounts();
  });
  els.typeFilter.addEventListener("change", () => {
    updateFilterStateFromUI();
    loadAccounts();
  });
  els.statusFilter.addEventListener("change", () => {
    updateFilterStateFromUI();
    loadAccounts();
  });

  els.btnRefresh.addEventListener("click", () => refreshUsageAndReload("manual"));
  els.btnExportData.addEventListener("click", exportAccountsData);
  els.btnImportData.addEventListener("click", () => {
    els.importFileInput.click();
  });
  els.importFileInput.addEventListener("change", () => {
    const file = els.importFileInput.files && els.importFileInput.files[0];
    if (!file) return;
    importAccountsDataFromFile(file);
  });

  els.btnPrevPage.addEventListener("click", () => {
    if (state.pagination.page <= 1) return;
    state.pagination.page -= 1;
    loadAccounts();
  });
  els.btnNextPage.addEventListener("click", () => {
    if (state.pagination.page >= state.pagination.pages) return;
    state.pagination.page += 1;
    loadAccounts();
  });

  els.tbody.addEventListener("click", (event) => {
    const target = event.target.closest(".btn-delete-account");
    if (!target) return;
    const id = Number(target.getAttribute("data-id") || "0");
    const name = target.getAttribute("data-name") || "";
    if (!id) return;
    deleteAccount(id, name);
  });

  els.btnAutoRefresh.addEventListener("click", () => {
    els.autoRefreshDropdown.classList.toggle("hidden");
  });
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!els.autoRefreshWrap.contains(target)) {
      els.autoRefreshDropdown.classList.add("hidden");
    }
  });
  els.autoRefreshEnabled.addEventListener("change", () => {
    state.autoRefresh.enabled = els.autoRefreshEnabled.checked;
    state.autoRefresh.countdown = state.autoRefresh.interval;
    persistAutoRefreshSettings();
    renderAutoRefreshLabel();
  });
  els.intervalOptions.addEventListener("click", (event) => {
    const target = event.target.closest(".interval-btn");
    if (!target) return;
    const sec = Number(target.getAttribute("data-sec") || "0");
    if (!AUTO_REFRESH_INTERVALS.includes(sec)) return;
    state.autoRefresh.interval = sec;
    state.autoRefresh.countdown = sec;
    persistAutoRefreshSettings();
    renderAutoRefreshLabel();
    renderIntervalOptions();
  });

  els.btnBgRefreshSave.addEventListener("click", saveBackgroundRefreshConfig);
  els.btnBgRefreshRun.addEventListener("click", runBackgroundRefreshNow);

  els.btnCreate.addEventListener("click", openCreateModal);
  els.btnCloseModal.addEventListener("click", closeCreateModal);
  els.btnCancelModal.addEventListener("click", closeCreateModal);
  els.modalMask.addEventListener("click", (event) => {
    if (event.target === els.modalMask) closeCreateModal();
  });

  els.formPlatform.addEventListener("change", syncCreateModeUI);
  els.formType.addEventListener("change", syncCreateModeUI);
  els.oauthCreateEnabled.addEventListener("change", syncCreateModeUI);
  els.btnGenerateUrl.addEventListener("click", generateOauthURL);
  els.btnCopyUrl.addEventListener("click", async () => {
    if (!state.oauthCreate.authUrl) return;
    await navigator.clipboard.writeText(state.oauthCreate.authUrl);
    showSuccess("授权 URL 已复制");
  });
  els.btnOpenUrl.addEventListener("click", () => {
    if (!state.oauthCreate.authUrl) return;
    window.open(state.oauthCreate.authUrl, "_blank", "noopener,noreferrer");
  });
  els.oauthAuthCode.addEventListener("blur", () => {
    const code = extractCode(els.oauthAuthCode.value);
    if (code) {
      els.oauthAuthCode.value = code;
    }
  });

  els.createForm.addEventListener("submit", handleCreateSubmit);
}

function startAutoRefreshTicker() {
  setInterval(async () => {
    if (!state.autoRefresh.enabled) return;
    if (!els.modalMask.classList.contains("hidden")) return;
    if (state.loading || state.refreshingUsage) return;

    if (state.autoRefresh.countdown <= 0) {
      state.autoRefresh.countdown = state.autoRefresh.interval;
      renderAutoRefreshLabel();
      await refreshUsageAndReload("auto");
      return;
    }

    state.autoRefresh.countdown -= 1;
    renderAutoRefreshLabel();
  }, 1000);
}

async function bootstrap() {
  loadAutoRefreshSettings();
  bindEvents();
  renderRows();
  renderSummary();
  renderBackgroundRefreshStatus();
  await fetchBackgroundRefreshStatus(true);
  await loadAccounts();
  startAutoRefreshTicker();
  startBackgroundRefreshStatusPolling();
}

bootstrap().catch((err) => {
  showError(String(err.message || err));
});
