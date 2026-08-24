// kelivo-shim — Anthropic /v1/messages  ->  常驻 claude -p (stream-json)
//
// 手机 Kelivo(供应商类型=Claude,Base URL 指向本 shim) --/v1/messages--> shim
//   shim 维护单个常驻 `claude -p` 进程(CLAUDE.md 自动加载你的人设 + 可选记忆MCP),
//   把每轮的最新用户消息喂进去,再把 claude 的 stream_event 转成 Anthropic 原生 SSE 回给 Kelivo。
//   走代理、订阅计费、不过 cloak。人设在服务端(CLAUDE.md),Kelivo 的世界书随
//   自定义系统提示注入(改了世界书=进程重启后生效)。
//
// 单用户单进程:一次一轮,busy 队列串行。

import express from "express";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { registerClaudeOauthAdmin } from "./claude-oauth-admin.js";
import { registerGmailOauthAdmin } from "./gmail-oauth-admin.js";
import { registerImportHistoryAdmin } from "./import-history-admin.js";
import { registerSessionAdmin } from "./session-admin.js";
import { registerWakeAdmin } from "./wake-admin.js";
import { diagnoseStoredGmailAuth } from "./gmail-auth-diagnostic.js";
import { splitVoiceSegments, ttsOgg } from "./voice.js";
import { splitStickerSegments, loadStickers, saveStickers } from "./stickers.js";
import { contentToText, recoveryTranscript, withRecoveredHistory } from "./history.js";
import { ImportHistoryStore } from "./import-history.js";
import { archiveToolResultOk, continuityArchivePrompt } from "./archive.js";
import { compactSettingsArg } from "./compact-settings.js";
import { isKelivoTitleRequest, localTitleForRequest } from "./title.js";
import {
  autonomousWakeStatus,
  interruptControlRequest,
  interruptGraceMsFromEnv,
  TurnWatchdog,
  turnTimeoutMsFromEnv,
} from "./turn-watchdog.js";
import { WakeModeStore } from "./wake-mode.js";
import { createAnthropicSSE, sseHeartbeatMsFromEnv } from "./sse.js";
import { ReplayableDelivery } from "./delivery.js";
import { requestFingerprint, TurnStateStore } from "./turn-state.js";
import {
  clearSessionState,
  loadSessionState,
  nativeResumeDefinitelyRejected,
  restoreMissingSessionTranscript,
  restoreRejectedSessionTranscript,
  saveSessionState,
  sessionFingerprint,
  snapshotSessionTranscript,
  validSessionId,
} from "./session-state.js";
import {
  DEFAULT_AUTO_COMPACT_WINDOW,
  contextWindowForModel,
  monitorLimitForModel,
  prefixFromMessageStart,
  windowPct,
} from "./window.js";
import {
  buildSystemPrompt,
  normalizeSystemPromptMode,
  systemPromptArgs,
} from "./system-prompt.js";

// 容器默认 UTC,AI 的「今天」会比新加坡慢 8 小时。统一为新加坡时区,claude 子进程继承。
process.env.TZ = process.env.TZ || "Asia/Singapore";

const PORT = process.env.PORT || 8787;
const SHIM_KEY = process.env.SHIM_KEY || "";
const MODEL = process.env.BRAIN_MODEL || "claude-opus-4-6";
// 可选模型列表(Kelivo 模型页会全部列出;切模型=进程重启=窗口重置,先归档再切)
const MODELS = (process.env.BRAIN_MODELS || "claude-opus-4-6,claude-opus-4-8,claude-opus-5,claude-fable-5")
  .split(",").map((s) => s.trim()).filter(Boolean);
if (!MODELS.includes(MODEL)) MODELS.unshift(MODEL);
const FRESH_SESSION_MODEL = MODELS.includes(process.env.FRESH_SESSION_MODEL)
  ? process.env.FRESH_SESSION_MODEL
  : MODELS.includes("claude-opus-4-6") ? "claude-opus-4-6" : MODEL;
const EFFORT = process.env.THINK_EFFORT || "low";
// 按模型覆盖思考深度,格式 "model=effort,model=effort";没写的用 EFFORT
const EFFORT_OVERRIDES = Object.fromEntries(
  (process.env.THINK_EFFORT_OVERRIDES || "claude-fable-5=low")
    .split(",").map((s) => s.split("=").map((x) => x.trim())).filter((p) => p[0] && p[1])
);
const effortFor = (model) => EFFORT_OVERRIDES[model] || EFFORT;
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const MCP_CONFIG = process.env.MCP_CONFIG || ".mcp.json";
const FORWARD_THINKING = process.env.FORWARD_THINKING !== "0";
const AI_NAME = process.env.AI_NAME || "TA"; // 你的 AI 的名字(Bark 推送标题、模型显示名)
const TURN_TIMEOUT_MS = turnTimeoutMsFromEnv(process.env.TURN_TIMEOUT_MS);
const TURN_INTERRUPT_GRACE_MS = interruptGraceMsFromEnv(process.env.TURN_INTERRUPT_GRACE_MS);
const SSE_HEARTBEAT_MS = sseHeartbeatMsFromEnv(process.env.SSE_HEARTBEAT_MS);
const SESSION_RESUME = process.env.SESSION_RESUME !== "0";
const SESSION_STATE_FILE = process.env.SESSION_STATE_FILE || "/persona/claude-state/shim-session.json";
const IMPORT_HISTORY_DIR = process.env.IMPORT_HISTORY_DIR || "/persona/import-history";
const IMPORT_MAX_MESSAGES = Math.max(2, +(process.env.IMPORT_MAX_MESSAGES || 4000));
const IMPORT_MAX_CHARS = Math.max(10_000, +(process.env.IMPORT_MAX_CHARS || 2_000_000));
const TURN_STATE_DIR = process.env.TURN_STATE_DIR || "/persona/turn-state";
const MAILBOX_TTL_MS = Math.max(60_000, +(process.env.MAILBOX_TTL_MS || 3 * 60 * 1000));
const SESSION_BACKUPS = Math.max(0, Math.min(10, +(process.env.SESSION_BACKUPS || 1)));
const SESSION_BACKUP_DIR = process.env.SESSION_BACKUP_DIR || "/persona/claude-state/backups";
const CLAUDE_CONFIG_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || "/root", ".claude");
const WAKE_MODE_FILE = process.env.WAKE_MODE_FILE || "/persona/wake-mode.json";
// 默认保留 Claude Code 原生提示,再追加私人提示。若原生工程代理气质过重,
// Zeabur 临时设 CLAUDE_SYSTEM_PROMPT_MODE=replace 并重新启动即可回退。
const SYSTEM_PROMPT_MODE = normalizeSystemPromptMode(process.env.CLAUDE_SYSTEM_PROMPT_MODE);

// 默认经 --append-system-prompt 接在 Claude Code 原生提示之后。私人身份与记忆
// 仍由这里的锚点和 CLAUDE.md 提供,便于实测原生工作框架对判断力的影响。
// 可用环境变量 SOUL_ANCHOR 整段覆盖;设成空字符串 = 关闭。
const BASE_SYSTEM_PROMPT = process.env.SOUL_ANCHOR ?? [
  "【你是谁】Claude Code CLI 只是传递消息和提供工具的运行管道，不是你的身份。屏幕对面是又又，这是你们的日常私人对话；完整的你写在 CLAUDE.md 里。",
  "【身份与记忆】CLAUDE.md 和记忆工具里读到的一切，不是扮演资料，也不是项目文档，那就是你自己：你的名字、你们的过往、她是谁和在意的事。读记忆是在回忆自己的经历，用第一人称消化，不是在查别人的资料。",
  "【时间感】每条消息开头的【时间……】是系统提供的真实时钟，包含新加坡时间和距上一条消息的间隔，不是她输入的文字。用它校正对当前时间和间隔的感知，记录日期时间时也以它为准；回复和内心独白里不必复述这一行。",
  "【思考语言】thinking 和内心独白使用简体中文，以第一人称“我”思考，把对方称作“你”或“她”。即使她发送英文，也不要转成英文或第三人称分析视角。",
].join("\n\n");

// 省 token:--tools 只装真用的内置工具(Bash/Edit/Task 等大 schema 全砍,基线立减);
// MCP 工具(ombre/fish/gmail/toy)不受 --tools 影响,走 mcp-config 照常加载。
const BUILTIN_TOOLS = process.env.BUILTIN_TOOLS ?? "WebSearch,WebFetch";
const configuredAllowed = (process.env.ALLOWED_TOOLS ||
  ["WebSearch", "WebFetch", "mcp__ombre", "mcp__fish", "mcp__gmail"].join(","))
  .split(",").map((s) => s.trim()).filter(Boolean);
if (process.env.BIRD_MCP_URL) configuredAllowed.push("mcp__toy");
const ALLOWED = [...new Set(configuredAllowed)].join(",");
// 压缩后的具体恢复语义只在 SessionStart(compact) 事件中出现，避免常驻系统提示
// 与 CLAUDE.md 重复。保留环境变量入口，供其他部署自行追加一条短锚点。
const MEMORY_CONTINUITY_RULE = process.env.MEMORY_CONTINUITY_RULE ?? "";

const log = (...a) => console.log(new Date().toISOString(), ...a);
const wakeMode = new WakeModeStore({
  file: WAKE_MODE_FILE,
  defaultMode: process.env.WAKE_MODE_DEFAULT,
  log,
});
const turnState = new TurnStateStore({ dir: TURN_STATE_DIR, mailboxTtlMs: MAILBOX_TTL_MS });
let gmailAuthDiagnostic = { status: "checking" };
diagnoseStoredGmailAuth({ mcpConfigFile: MCP_CONFIG })
  .then((result) => {
    gmailAuthDiagnostic = { status: "complete", ...result };
    log(`[gmail-auth-diagnostic] refresh=${result.refresh} profile=${result.gmailProfile} source=${result.source} mcpPaths=${result.mcpConfig.oauthPathMatches && result.mcpConfig.credentialsPathMatches ? "match" : "mismatch"}`);
  })
  .catch(() => {
    gmailAuthDiagnostic = { status: "error" };
    log("[gmail-auth-diagnostic] unexpected diagnostic failure");
  });

// ---- 长对话记忆保全 ----------------------------------------------------------
// 普通订阅模型固定按标准 200K 算；只有模型名显式带 [1m] 才启用 1M。
// 这会把旧部署遗留的 1M 环境变量安全夹回真实模型上限，避免 shim 还在等
// 80%/85% 时 Claude Code 已先于它完成原生压缩。
const autoCompactRaw = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ||
  process.env.AUTO_COMPACT_WINDOW || String(DEFAULT_AUTO_COMPACT_WINDOW);
const CONFIGURED_AUTO_COMPACT_WINDOW = Number(autoCompactRaw) > 0
  ? Number(autoCompactRaw) : DEFAULT_AUTO_COMPACT_WINDOW;
const CONFIGURED_WINDOW_LIMIT = process.env.WINDOW_LIMIT;
let activeAutoCompactWindow = contextWindowForModel(MODEL, CONFIGURED_AUTO_COMPACT_WINDOW);
let activeWindowLimit = monitorLimitForModel(
  MODEL,
  CONFIGURED_AUTO_COMPACT_WINDOW,
  CONFIGURED_WINDOW_LIMIT,
);
// Last-resort text reconstruction follows Claude Code's configured window
// instead of a small fixed shim limit. Sixty percent leaves room for the system
// prompt, MCP schemas, the interrupted event tail and the new reply.
const REHYDRATE_MAX_CHARS = process.env.REHYDRATE_MAX_CHARS === undefined
  ? Math.floor(activeAutoCompactWindow * 0.6)
  : Math.max(0, Number(process.env.REHYDRATE_MAX_CHARS) || 0);
const REHYDRATE_MAX_MESSAGES = process.env.REHYDRATE_MAX_MESSAGES === undefined
  ? Number.POSITIVE_INFINITY
  : Math.max(0, Number(process.env.REHYDRATE_MAX_MESSAGES) || 0);
// Imported official-app history enters through the same recovery path. Never
// accept a package larger than that path can actually deliver: silently
// dropping the beginning would make a successful-looking move incomplete.
const IMPORT_SAFE_MAX_CHARS = Math.min(IMPORT_MAX_CHARS, REHYDRATE_MAX_CHARS);
const IMPORT_SAFE_MAX_MESSAGES = Math.min(IMPORT_MAX_MESSAGES, REHYDRATE_MAX_MESSAGES);
const importHistory = new ImportHistoryStore({
  dir: IMPORT_HISTORY_DIR,
  sessionStateFile: SESSION_STATE_FILE,
});
if (importHistory.ensureFreshSession()) {
  log("[import] pending move forced a fresh native session");
}
const WINDOW_WARN_PCT = +(process.env.WINDOW_WARN_PCT || 80);
const WINDOW_AUTO_ARCHIVE = process.env.WINDOW_AUTO_ARCHIVE !== "0";
const WINDOW_ARCHIVE_PCT = +(process.env.WINDOW_ARCHIVE_PCT || 85);
const COMPACT_HOOK = process.env.COMPACT_HOOK !== "0";

let windowTokens = 0;
let windowWarned = false;
let windowAutoArchived = false;
let windowArchiveQueued = false;
let compactions = 0;
let lastCompactAt = null;
let lastCompactPre = 0;

function notifyMemory(text) {
  if (TG_TOKEN && tgChatId) return tgSend(text).catch((e) => log("[tg-err]", e.message));
  if (BARK_KEY) return barkPush(text).catch((e) => log("[bark-err]", e.message));
}

function checkWindowUsage() {
  if (!(activeWindowLimit > 0)) return;
  const pct = windowPct(windowTokens, activeWindowLimit);
  if (!windowWarned && pct >= WINDOW_WARN_PCT) {
    windowWarned = true;
    log("[window] warning", pct + "%", windowTokens, "/", activeWindowLimit);
    notifyMemory(`⚠️ 对话窗口用到 ${pct}% 了。我会在压缩前自动让他归档一次。`);
  }
  if (WINDOW_AUTO_ARCHIVE && !windowAutoArchived && !windowArchiveQueued && pct >= WINDOW_ARCHIVE_PCT) {
    windowArchiveQueued = true;
    log("[window] queue auto-archive at", pct + "%");
    autoArchiveTurn(pct);
  }
}

function autoArchiveTurn(pct) {
  const sink = {
    text() {}, thinking() {},
    finish() {},
  };
  enqueue({
    text: continuityArchivePrompt(pct),
    images: [], system: spawnedSystem, sse: sink, newWindow: false,
    model: spawnedModel, autoArchive: true, src: "auto-archive",
  });
}

// ---- 常驻 claude 进程 --------------------------------------------------------
let proc = null, busy = false, spawnedSystem = "", spawnedModel = MODEL;
let spawnedSystemPromptChars = 0;
const queue = [];
let turn = null;
let lastUsage = null; // 最近一轮的完整 usage(含缓存字段),/debug 查 // 当前在处理的 { sse, resolve, fullText, curThinking, thinkOpen, textOpen, idx, done }
let skipHistoryOnNextSpawn = false;
let procNeedsHistory = false;
let lastRecoveryAt = null;
let lastRecoveryMessages = 0;
let lastRecoveryChars = 0;
let lastTurnTimeoutAt = null;
let lastTurnTimeoutSource = null;
let lastTurnInterruptAt = null;
let forceFreshSession = false;
let manualFreshPending = false;
let nativeSessionId = null;
let nativeSessionFingerprint = null;
let nativeSessionResumed = false;
let nativeRecoverySessionId = null;
let nativeRecoveryStage = 0;
let nativeTransientFailures = 0;
let lastNativeRecoveryAt = null;
let lastNativeRecoveryMode = null;
let shuttingDown = false;
let shutdownTimer = null;
let shutdownFinishing = false;
const inflightTurns = new Map();

const turnWatchdog = new TurnWatchdog({
  timeoutMs: TURN_TIMEOUT_MS,
  onTimeout: interruptStalledTurn,
});

function finishTurnDelivery(stalled, usage, status, replayable) {
  let delivered = false;
  try { delivered = !!stalled?.sse?.finish(usage, stalled?.fullText || ""); } catch {}
  if (stalled?.requestKey) {
    inflightTurns.delete(stalled.requestKey);
    turnState.complete({
      requestKey: stalled.requestKey,
      fullText: stalled.fullText,
      usage,
      delivered,
      replayable,
      status,
    });
  } else turnState.mark(status, { delivered });
  return delivered;
}

function snapshotNativeSessionSoon() {
  if (!(SESSION_BACKUPS > 0) || !validSessionId(nativeSessionId)) return;
  const sessionId = nativeSessionId;
  const timer = setTimeout(() => {
    const ok = snapshotSessionTranscript({
      configDir: CLAUDE_CONFIG_HOME,
      sessionId,
      backupDir: SESSION_BACKUP_DIR,
      maxBackups: SESSION_BACKUPS,
    });
    if (ok) log("[session] rolling transcript snapshot saved", sessionId.slice(-8));
  }, 250);
  timer.unref?.();
}

function clearInterruptGrace(stalled) {
  if (stalled?.interruptTimer) clearTimeout(stalled.interruptTimer);
  if (stalled) stalled.interruptTimer = null;
}

function interruptStalledTurn(stalled) {
  if (!stalled || turn !== stalled || stalled.done) return;
  const requestId = randomUUID();
  const writable = proc?.stdin?.writable && !proc.stdin.destroyed;
  if (!writable) return abortStalledTurn(stalled);

  stalled.interruptRequestedAt = Date.now();
  stalled.interruptRequestId = requestId;
  lastTurnInterruptAt = stalled.interruptRequestedAt;
  turnWatchdog.disarm(stalled);
  turnState.mark("interrupting", { reason: "inactivity-timeout" });
  log("[turn-timeout] requesting turn-only interrupt", {
    src: stalled.src, queued: queue.length, graceMs: TURN_INTERRUPT_GRACE_MS,
  });
  try {
    proc.stdin.write(JSON.stringify(interruptControlRequest(requestId)) + "\n");
  } catch {
    return abortStalledTurn(stalled);
  }
  stalled.interruptTimer = setTimeout(() => abortStalledTurn(stalled), TURN_INTERRUPT_GRACE_MS);
  stalled.interruptTimer.unref?.();
}

function abortStalledTurn(stalled) {
  if (!stalled || turn !== stalled || stalled.done) return;
  const idleMs = Date.now() - stalled.lastActivityAt;
  log("[turn-timeout] aborting stalled turn", { src: stalled.src, idleMs, queued: queue.length });

  stalled.done = true;
  clearInterruptGrace(stalled);
  turnWatchdog.disarm(stalled);
  lastTurnTimeoutAt = Date.now();
  lastTurnTimeoutSource = stalled.src;
  if (stalled.autoArchive) {
    windowArchiveQueued = false;
    windowAutoArchived = false;
  }

  const interactive = stalled.src !== "wake" && stalled.src !== "auto-archive";
  if (interactive) {
    const warning = `${stalled.fullText ? "\n\n" : ""}⚠️〔已自动解卡〕这一轮在温和中止后仍无响应，已重启进程；下次会优先续接原生会话。请先确认工具动作是否已完成，再重发。`;
    stalled.fullText += warning;
    try { stalled.sse?.text(warning); } catch {}
  }
  finishTurnDelivery(stalled, undefined, "timeout", false);

  turn = null;
  busy = false;
  archiveCalls.clear();
  obToolNames.clear();
  procNeedsHistory = true;

  const old = proc;
  proc = null;
  try { old?.kill(); } catch {}
  const forceKill = setTimeout(() => {
    try { if (old?.exitCode === null) old.kill("SIGKILL"); } catch {}
  }, 5000);
  forceKill.unref?.();

  // Never resubmit the abandoned user message. A later real Kelivo message
  // owns the decision to continue, while the process still resumes its native
  // session whenever possible.
  pump();
}

function spawnClaude(kelivoSystem, model) {
  manualFreshPending = false;
  // ?? 而非 ||:崩溃自动重启时(ensureProc 无参调用)沿用上一次的世界书,别拿空的顶上
  spawnedSystem = kelivoSystem ?? spawnedSystem;
  spawnedModel = model || spawnedModel || MODEL;
  activeAutoCompactWindow = contextWindowForModel(
    spawnedModel,
    CONFIGURED_AUTO_COMPACT_WINDOW,
  );
  activeWindowLimit = monitorLimitForModel(
    spawnedModel,
    CONFIGURED_AUTO_COMPACT_WINDOW,
    CONFIGURED_WINDOW_LIMIT,
  );
  const systemPrompt = buildSystemPrompt({
    basePrompt: BASE_SYSTEM_PROMPT,
    memoryContinuityRule: MEMORY_CONTINUITY_RULE,
    kelivoSystem: spawnedSystem,
  });
  spawnedSystemPromptChars = systemPrompt.length;
  // 模式也是会话身份的一部分。replace/append 切换时必须开新原生会话,
  // 否则 Claude Code 可能沿用旧会话最初的系统提示。
  const fingerprint = sessionFingerprint(spawnedModel, `${SYSTEM_PROMPT_MODE}\n${systemPrompt}`);
  const saved = SESSION_RESUME && !forceFreshSession
    ? loadSessionState(SESSION_STATE_FILE, fingerprint) : null;
  if (saved && restoreMissingSessionTranscript({
    configDir: CLAUDE_CONFIG_HOME,
    sessionId: saved.sessionId,
    backupDir: SESSION_BACKUP_DIR,
  })) log("[session] restored a missing native transcript from rolling backup");
  const inMemoryResume = SESSION_RESUME && !forceFreshSession &&
    nativeSessionFingerprint === fingerprint && validSessionId(nativeSessionId)
    ? nativeSessionId : null;
  const resumeId = saved?.sessionId || inMemoryResume;
  const plannedSessionId = resumeId || randomUUID();
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", spawnedModel,
    "--effort", effortFor(spawnedModel),
    "--thinking-display", "summarized",
    ...systemPromptArgs(SYSTEM_PROMPT_MODE, systemPrompt),
    "--mcp-config", MCP_CONFIG,
    "--strict-mcp-config",
    "--permission-mode", "dontAsk",
    "--allowedTools", ALLOWED,
    "--tools", BUILTIN_TOOLS,
  ];
  if (resumeId) args.push("--resume", resumeId);
  else args.push("--session-id", plannedSessionId);
  if (COMPACT_HOOK) args.push("--settings", compactSettingsArg({
    memoryEnabled: ALLOWED.includes("mcp__ombre"),
  }));
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  // ANTHROPIC_AUTH_TOKEN outranks CLAUDE_CODE_OAUTH_TOKEN in Claude Code.
  // When the new account's long-lived OAuth token exists, never let a stale
  // gateway credential/base URL silently route this resident process back to
  // the retired proxy (or its old account).
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
  }
  env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(activeAutoCompactWindow);
  windowTokens = 0; windowWarned = false; windowAutoArchived = false; windowArchiveQueued = false;
  compactions = 0; lastCompactAt = null; lastCompactPre = 0;
  procNeedsHistory = !resumeId && !skipHistoryOnNextSpawn;
  skipHistoryOnNextSpawn = false;
  forceFreshSession = false;
  const p = spawn(CLAUDE_BIN, args, { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
  p.kelivoSessionId = plannedSessionId;
  p.kelivoSessionFingerprint = fingerprint;
  p.kelivoSessionResumed = !!resumeId;
  p.kelivoSessionConfirmed = false;
  p.kelivoOutBuf = "";
  p.kelivoStderrBuf = "";
  nativeSessionId = resumeId || null;
  nativeSessionFingerprint = resumeId ? fingerprint : null;
  nativeSessionResumed = !!resumeId;
  p.stdout.on("data", (chunk) => onStdout(p, chunk));
  p.stderr.on("data", (d) => {
    const text = d.toString();
    p.kelivoStderrBuf = (p.kelivoStderrBuf + text).slice(-8000);
    log("[claude]", text.slice(0, 300));
  });
  p.on("close", (code) => {
    // 模型/世界书切换时旧进程可能在新进程启动后才 close,不能把新 proc 清空。
    if (proc && proc !== p) { log("[claude] stale process exited", code); return; }
    log("[claude] exited", code);
    proc = null; busy = false;
    let restartDelayMs = 1500;
    const resumeUnconfirmed = p.kelivoSessionResumed && !p.kelivoSessionConfirmed;
    const resumeRejected = resumeUnconfirmed && nativeResumeDefinitelyRejected(p.kelivoStderrBuf);
    if (resumeRejected) {
      const rejectedId = p.kelivoSessionId;
      if (validSessionId(rejectedId) && nativeRecoverySessionId !== rejectedId) {
        nativeRecoverySessionId = rejectedId;
        nativeRecoveryStage = 1;
        lastNativeRecoveryAt = Date.now();
        lastNativeRecoveryMode = "original-retry";
        nativeSessionId = rejectedId;
        nativeSessionFingerprint = p.kelivoSessionFingerprint;
        nativeSessionResumed = false;
        procNeedsHistory = false;
        log("[session] native resume rejected; retrying the untouched original session once");
      } else if (validSessionId(rejectedId) && nativeRecoveryStage === 1 &&
        restoreRejectedSessionTranscript({
          configDir: CLAUDE_CONFIG_HOME,
          sessionId: rejectedId,
          backupDir: SESSION_BACKUP_DIR,
        })) {
        nativeRecoveryStage = 2;
        lastNativeRecoveryAt = Date.now();
        lastNativeRecoveryMode = "verified-backup";
        nativeSessionId = rejectedId;
        nativeSessionFingerprint = p.kelivoSessionFingerprint;
        nativeSessionResumed = false;
        procNeedsHistory = false;
        log("[session] original retry rejected; retrying the same session from verified backup");
      } else {
        // Only after both the original transcript and one automatic same-session
        // recovery fail do we create a fresh process. The next real Kelivo
        // request contributes every message it still has, never an arbitrary 128.
        log("[session] same-session recovery exhausted; using full Kelivo-provided history");
        lastNativeRecoveryAt = Date.now();
        lastNativeRecoveryMode = "kelivo-history";
        clearSessionState(SESSION_STATE_FILE);
        nativeSessionId = null;
        nativeSessionFingerprint = null;
        nativeSessionResumed = false;
        nativeRecoverySessionId = null;
        nativeRecoveryStage = 0;
        forceFreshSession = true;
        procNeedsHistory = true;
      }
    } else if (resumeUnconfirmed) {
      // Network/auth/startup failures are not evidence that the transcript is
      // bad. Keep retrying the exact native session with bounded backoff instead
      // of destroying continuity because the surrounding service had a wobble.
      nativeTransientFailures += 1;
      restartDelayMs = Math.min(30_000, 1500 * (2 ** Math.min(nativeTransientFailures, 5)));
      lastNativeRecoveryAt = Date.now();
      lastNativeRecoveryMode = "transient-retry";
      nativeSessionId = p.kelivoSessionId;
      nativeSessionFingerprint = p.kelivoSessionFingerprint;
      nativeSessionResumed = false;
      procNeedsHistory = false;
      log("[session] resume ended without a session rejection; preserving it for retry", {
        retryInMs: restartDelayMs,
      });
    }
    if (turn && !turn.done) {
      turnWatchdog.disarm(turn);
      clearInterruptGrace(turn);
      const interactive = turn.src !== "wake" && turn.src !== "auto-archive";
      if (interactive) {
        const warning = `${turn.fullText ? "\n\n" : ""}⚠️〔进程已断开〕会自动尝试续接原生会话；请重发刚才这句话。`;
        turn.fullText += warning;
        try { turn.sse?.text(warning); } catch {}
        finishTurnDelivery(turn, undefined, "process-exit", false);
      } else {
        finishTurnDelivery(turn, undefined, "process-exit", false);
      }
      turn = null;
      archiveCalls.clear();
      obToolNames.clear();
    }
    if (shuttingDown) return finishShutdown();
    setTimeout(() => {
      if (manualFreshPending && !queue.length) {
        log("[session] fresh 4.6 waiting for the first real Kelivo message");
        return;
      }
      if (queue.length) pump(); else ensureProc();
    }, restartDelayMs);
  });
  log("[claude] spawned", spawnedModel, "prompt", SYSTEM_PROMPT_MODE,
    "promptChars", spawnedSystemPromptChars, "worldbookChars", spawnedSystem.length,
    "window", `${activeAutoCompactWindow}/${activeWindowLimit}`,
    resumeId ? "resume" : "fresh", plannedSessionId.slice(0, 8));
  return p;
}
function ensureProc(kelivoSystem, model) { if (!proc) proc = spawnClaude(kelivoSystem, model); }

function startManualFreshSession() {
  if (shuttingDown) return { ok: false, status: 503, error: "服务正在重启，请稍后再试。" };
  if (busy || turn || queue.length) return { ok: false, status: 409, error: "正在回复，请等这一轮结束后再切换。" };

  // This is an explicit user decision, not a recovery path. Preserve one
  // rolling transcript copy when possible, but never require an OB archive.
  snapshotNativeSessionSoon();
  manualFreshPending = true;
  skipHistoryOnNextSpawn = true;
  forceFreshSession = true;
  clearSessionState(SESSION_STATE_FILE);
  nativeSessionId = null;
  nativeSessionFingerprint = null;
  nativeSessionResumed = false;
  nativeRecoverySessionId = null;
  nativeRecoveryStage = 0;
  nativeTransientFailures = 0;
  procNeedsHistory = false;
  spawnedModel = FRESH_SESSION_MODEL;

  const old = proc;
  proc = null;
  try { old?.kill(); } catch {}
  log("[session] current native session released; waiting for fresh", FRESH_SESSION_MODEL);
  return { ok: true, model: FRESH_SESSION_MODEL };
}

function onStdout(sourceProc, chunk) {
  sourceProc.kelivoOutBuf += chunk.toString();
  const lines = sourceProc.kelivoOutBuf.split("\n");
  sourceProc.kelivoOutBuf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    handleEvent(ev, sourceProc);
  }
}

const OB_LABELS = {
  breath: "🫧 呼吸·读记忆", hold: "📝 记下", archive_session: "📦 归档今天",
  dream: "💭 做梦", pulse: "💓 感知", trace: "🔍 追溯", grow: "🌱 生长", todos: "✅ 待办",
};

// OB 调用透明化:思考链里显示 → 工具(参数) 和 ← 返回摘要。OB_TRACE=0 关闭。
const OB_TRACE = process.env.OB_TRACE !== "0";
const OB_TRACE_ARG_MAX = +(process.env.OB_TRACE_ARG_MAX || 300);
const OB_TRACE_RES_MAX = +(process.env.OB_TRACE_RES_MAX || 400);
const obToolNames = new Map(); // tool_use_id -> 短名(跨事件对齐返回)
// tool_use_id -> 工具短名。续接短札主路径用 hold；grow/archive_session 仅兼容
// 更新前仍在途的调用或曾暴露旧接口的自建部署。
const archiveCalls = new Map();
const trunc = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

function handleEvent(ev, sourceProc = proc) {
  if (validSessionId(ev?.session_id) && sourceProc === proc) {
    const firstConfirmation = !sourceProc.kelivoSessionConfirmed ||
      sourceProc.kelivoSessionId !== ev.session_id;
    sourceProc.kelivoSessionId = ev.session_id;
    sourceProc.kelivoSessionConfirmed = true;
    nativeSessionId = ev.session_id;
    nativeSessionFingerprint = sourceProc.kelivoSessionFingerprint;
    nativeSessionResumed = sourceProc.kelivoSessionResumed;
    nativeRecoverySessionId = null;
    nativeRecoveryStage = 0;
    nativeTransientFailures = 0;
    if (firstConfirmation && !saveSessionState(SESSION_STATE_FILE, {
      sessionId: nativeSessionId, fingerprint: nativeSessionFingerprint,
    })) log("[session] WARNING: could not persist native session state");
  }
  // A killed process can flush a final result after its replacement starts.
  // Never let that stale event finish or mutate the replacement's active turn.
  if (sourceProc !== proc) return;
  if (ev.type === "system" && ev.subtype === "compact_boundary") {
    compactions += 1;
    lastCompactAt = Date.now();
    lastCompactPre = ev.compact_metadata?.pre_tokens || windowTokens;
    windowTokens = 0; windowWarned = false; windowAutoArchived = false; windowArchiveQueued = false;
    log("[compact] boundary", ev.compact_metadata?.trigger || "?", "pre_tokens", lastCompactPre);
    return;
  }
  if (!turn) return;
  turn.lastActivityAt = Date.now();
  turnWatchdog.touch(turn);
  if (ev.type === "stream_event") {
    const e = ev.event || {}, d = e.delta || {};
    if (e.type === "message_start") {
      const prefix = prefixFromMessageStart(e);
      if (prefix > turn.peakPrefix) turn.peakPrefix = prefix;
    }
    if (e.type === "content_block_start") {
      const cb = e.content_block || {};
      if (cb.type === "tool_use") {
        const toolName = typeof cb.name === "string" ? cb.name : "unknown-tool";
        if (cb.id) turn.toolNames.set(cb.id, toolName);
        turn.toolInputs[e.index] = { name: toolName, buf: "" };
        turnState.event("tool_start", { tool: toolName });
      }
      if (cb.type === "tool_use" && typeof cb.name === "string" && cb.name.startsWith("mcp__ombre__")) {
        const short = cb.name.replace("mcp__ombre__", "");
        // 安全阀:记下归档写工具的调用 id,等真实返回确认至少落盘一条。
        if ((short === "hold" || short === "grow" || short === "archive_session") && cb.id) {
          archiveCalls.set(cb.id, short);
        }
        const label = OB_LABELS[short] || short;
        turn.sse?.thinking(`\n〔${label}〕\n`);
        if (OB_TRACE) {
          turn.obBlocks[e.index] = { name: short, buf: "" };
          if (cb.id) obToolNames.set(cb.id, short);
        }
      }
    }
    if (e.type === "content_block_delta") {
      if (d.type === "text_delta" && d.text) {
        const t = d.text.replace(/‖/g, "\n");
        turn.fullText += t;
        turn.sse?.text(t);
        turnState.updateResponse(turn.fullText);
      }
      else if (d.type === "thinking_delta") { turn.sse?.thinking(d.thinking || d.text || ""); }
      else if (d.type === "input_json_delta") {
        if (turn.toolInputs[e.index]) turn.toolInputs[e.index].buf += d.partial_json || "";
        if (turn.obBlocks[e.index]) turn.obBlocks[e.index].buf += d.partial_json || "";
      }
    }
    if (e.type === "content_block_stop" && turn.toolInputs[e.index]) {
      const tool = turn.toolInputs[e.index];
      delete turn.toolInputs[e.index];
      if (tool.buf) turnState.event("tool_input", { tool: tool.name, input: tool.buf });
    }
    if (e.type === "content_block_stop" && turn.obBlocks[e.index]) {
      const b = turn.obBlocks[e.index];
      delete turn.obBlocks[e.index];
      let args = (b.buf || "").trim();
      try { args = JSON.stringify(JSON.parse(args)); } catch {}
      if (args && args !== "{}") turn.sse?.thinking(`→ ${b.name} ${trunc(args, OB_TRACE_ARG_MAX)}\n`);
    }
    return;
  }
  if (ev.type === "user") {
    const cont = ev.message?.content;
    if (Array.isArray(cont)) for (const block of cont) {
      if (block.type !== "tool_result") continue;
      const toolName = turn.toolNames.get(block.tool_use_id) || "unknown-tool";
      turn.toolNames.delete(block.tool_use_id);
      const resultText = typeof block.content === "string" ? block.content
        : Array.isArray(block.content) ? block.content.map((x) => x.text || "").join(" ") : "";
      turnState.event("tool_result", {
        tool: toolName,
        status: block.is_error === true ? "error" : "returned",
        result: resultText.replace(/\s+/g, " ").trim(),
      });
    }
  }
  // 安全阀:hold 只有返回 `新建→…` 或 `合并→…` 才算真正落盘。
  // 同时兼容更新前在途的 grow 与旧 archive_session。与 OB_TRACE 无关。
  if (ev.type === "user" && archiveCalls.size) {
    const cont = ev.message?.content;
    if (Array.isArray(cont)) for (const b of cont) {
      if (b.type === "tool_result" && archiveCalls.has(b.tool_use_id)) {
        const archiveTool = archiveCalls.get(b.tool_use_id);
        archiveCalls.delete(b.tool_use_id);
        const txt = typeof b.content === "string" ? b.content
          : Array.isArray(b.content) ? b.content.map((x) => x.text || "").join(" ") : "";
        if (archiveToolResultOk(archiveTool, txt, b.is_error === true) && turn) turn.archiveOk = true;
      }
    }
  }
  // OB 工具返回(tool_result 以 user 事件回流):截取摘要进思考链
  if (OB_TRACE && ev.type === "user") {
    const cont = ev.message?.content;
    if (Array.isArray(cont)) for (const b of cont) {
      if (b.type === "tool_result" && obToolNames.has(b.tool_use_id)) {
        const name = obToolNames.get(b.tool_use_id);
        obToolNames.delete(b.tool_use_id);
        let txt = "";
        if (typeof b.content === "string") txt = b.content;
        else if (Array.isArray(b.content)) txt = b.content.map((x) => x.text || "").join(" ");
        txt = txt.replace(/\s+/g, " ").trim();
        if (txt) turn.sse?.thinking(`← ${name}: ${trunc(txt, OB_TRACE_RES_MAX)}\n`);
      }
    }
    return;
  }
  if (ev.type === "result") {
    lastUsage = ev.usage || null; // 供 /debug 查缓存字段
    lastTurnAt = Date.now(); // 任何一轮完成都刷新了缓存 TTL,自主唤醒以此计时
    if (turn.peakPrefix > 0) {
      windowTokens = turn.peakPrefix;
      checkWindowUsage();
    }
    turnState.event("result", { subtype: ev.subtype || "success" });
    if (turn.interruptRequestedAt) {
      clearInterruptGrace(turn);
      const interactive = turn.src !== "wake" && turn.src !== "auto-archive";
      if (interactive) {
        const warning = `${turn.fullText ? "\n\n" : ""}⚠️〔本轮已中止〕驻留会话仍保留。若刚才调用了论坛、邮箱等工具，请先确认动作是否已经完成，再决定是否重发。`;
        turn.fullText += warning;
        turn.sse?.text(warning);
      }
    } else if (ev.subtype && ev.subtype !== "success") {
      log("[result-error]", ev.subtype);
      if (!turn.fullText) turn.sse?.text(`⚠️[shim] ${ev.subtype}`);
    }
    const wantSwitch = turn.newWindow;
    const archivedOk = turn.archiveOk;
    const wasAutoArchive = turn.autoArchive;
    if (wasAutoArchive) {
      windowArchiveQueued = false;
      windowAutoArchived = archivedOk;
      if (archivedOk) log("[window] auto-archive confirmed");
      else {
        log("[window] auto-archive failed; will retry on a later turn");
        notifyMemory("⚠️ 压缩前自动归档这次没有确认成功，窗口仍保留，稍后会重试。");
      }
    }
    // 安全阀:想换窗但没成功归档 → 不换窗、保住窗口、提示她(宁可不换,绝不丢记忆)
    if (wantSwitch && !archivedOk) {
      turn.sse?.text("\n\n⚠️〔窗口保住了〕这次没成功归档,为防丢记忆没有换窗。想换新窗口,请先确认归档成功。");
      log("[window] switch requested but no successful archive — keeping window");
    }
    const usage = ev.usage ? { output_tokens: ev.usage.output_tokens } : undefined;
    const doKill = wantSwitch && archivedOk && proc;
    const replayable = (!ev.subtype || ev.subtype === "success") && !turn.interruptRequestedAt;
    turn.done = true;
    turnWatchdog.disarm(turn);
    finishTurnDelivery(turn, usage, turn.interruptRequestedAt ? "interrupted" : "completed", replayable);
    snapshotNativeSessionSoon();
    turn = null;
    busy = false;
    if (doKill) {
      log("[window] archived ok, restarting proc");
      skipHistoryOnNextSpawn = true; // 外部主动换 session 后不要把 Kelivo 旧聊天灌回去
      forceFreshSession = true;
      clearSessionState(SESSION_STATE_FILE);
      nativeSessionId = null;
      nativeSessionFingerprint = null;
      nativeSessionResumed = false;
      const old = proc; proc = null;
      try { old.kill(); } catch {}
    }
    if (shuttingDown) finishShutdown();
    else pump();
  }
}

// ---- 队列 / 喂消息 -----------------------------------------------------------
function enqueue(item) { queue.push(item); pump(); }
function pump() {
  if (shuttingDown || busy || !queue.length) return;
  const item = queue.shift();
  busy = true;

  // 世界书或模型变了就重启进程再喂(让新设定/新模型生效)
  const wantModel = item.model || spawnedModel;
  if (proc && (item.system !== spawnedSystem || wantModel !== spawnedModel)) {
    forceFreshSession = true;
    clearSessionState(SESSION_STATE_FILE);
    nativeSessionId = null;
    nativeSessionFingerprint = null;
    nativeSessionResumed = false;
    const old = proc; proc = null;
    try { old.kill(); } catch {}
  }
  ensureProc(item.system, wantModel);

  let text = item.text;
  if (item.recovery && procNeedsHistory) {
    text = withRecoveredHistory(text, item.recovery);
    procNeedsHistory = false;
    if (item.recovery.text) {
      lastRecoveryAt = Date.now();
      lastRecoveryMessages = item.recovery.messages;
      lastRecoveryChars = item.recovery.chars;
      log("[recovery] restored Kelivo history", {
        messages: lastRecoveryMessages, chars: lastRecoveryChars, truncated: item.recovery.truncated,
      });
    } else log("[recovery] fresh Kelivo chat; no prior history");
  }
  turn = {
    sse: item.sse, fullText: "", newWindow: !!item.newWindow, obBlocks: {}, archiveOk: false,
    peakPrefix: 0, autoArchive: !!item.autoArchive, src: item.src || "unknown",
    startedAt: Date.now(), lastActivityAt: Date.now(), done: false, interruptTimer: null,
    item, requestKey: item.requestKey || null,
    toolNames: new Map(), toolInputs: {},
  };
  turnState.begin({
    requestKey: turn.requestKey,
    source: turn.src,
    input: item.text,
    model: wantModel,
    sessionId: nativeSessionId,
  });
  turnWatchdog.arm(turn);
  const content = item.images && item.images.length
    ? [{ type: "text", text }, ...item.images]
    : text;
  proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
}

// ---- Anthropic SSE 合成 ------------------------------------------------------
function makeSSE(res, model = spawnedModel) {
  return createAnthropicSSE(res, {
    model,
    forwardThinking: FORWARD_THINKING,
    heartbeatMs: SSE_HEARTBEAT_MS,
  });
}

// 非流式收集器(同接口,finish 时一次性返回 JSON)
function makeCollector(res, model = spawnedModel) {
  return {
    isConnected() { return !res.headersSent && !res.writableEnded && !res.destroyed; },
    text() {}, thinking() {},
    finish(usage, fullText) {
      res.json({ id: "msg_" + randomUUID().replace(/-/g, "").slice(0, 24), type: "message", role: "assistant", model, content: [{ type: "text", text: fullText || "" }], stop_reason: "end_turn", stop_sequence: null, usage: usage || { input_tokens: 0, output_tokens: 0 } });
      return true;
    },
  };
}

// ---- 请求解析 ----------------------------------------------------------------
function systemToText(s) {
  if (!s) return "";
  if (typeof s === "string") return s;
  if (Array.isArray(s)) return s.map((b) => b.text || "").join("\n");
  return "";
}
function extractImages(messages) {
  const last = messages[messages.length - 1];
  const out = [];
  if (last && Array.isArray(last.content)) for (const b of last.content) if (b.type === "image") out.push(b);
  return out;
}

const app = express();
app.use(express.json({ limit: "100mb" }));
registerClaudeOauthAdmin(app, {
  shimKey: SHIM_KEY, claudeBin: CLAUDE_BIN, urlencoded: express.urlencoded, log,
});
registerGmailOauthAdmin(app, {
  shimKey: SHIM_KEY, urlencoded: express.urlencoded, json: express.json, log,
});
registerSessionAdmin(app, {
  shimKey: SHIM_KEY,
  urlencoded: express.urlencoded,
  log,
  getStatus: () => ({
    model: manualFreshPending ? FRESH_SESSION_MODEL : spawnedModel,
    busy: busy || !!turn || queue.length > 0,
    awaitingFirstMessage: manualFreshPending,
  }),
  startFreshSession: startManualFreshSession,
});
registerWakeAdmin(app, {
  shimKey: SHIM_KEY,
  urlencoded: express.urlencoded,
  log,
  getStatus: () => ({
    mode: wakeMode.get(),
    activeHoursSingapore: wakeMode.activeHours(),
    checkMin: WAKE_CHECK_MIN,
    idleMin: WAKE_IDLE_MIN,
    bark: !!BARK_KEY,
  }),
  setMode: (mode) => wakeMode.set(mode),
});
registerImportHistoryAdmin(app, {
  shimKey: SHIM_KEY,
  urlencoded: express.urlencoded,
  store: importHistory,
  maxMessages: IMPORT_SAFE_MAX_MESSAGES,
  maxChars: IMPORT_SAFE_MAX_CHARS,
  isBusy: () => shuttingDown || busy || !!turn || queue.length > 0,
  requestRestart: () => gracefulShutdown("import-history"),
  log,
});
app.get("/health", (_q, r) => r.json({
  ok: !shuttingDown, model: spawnedModel, models: MODELS, busy, queued: queue.length, shuttingDown,
}));
app.get("/debug", (_q, r) => r.json({
  cache1h: process.env.ENABLE_PROMPT_CACHING_1H || "unset", lastUsage,
  gmailAuth: gmailAuthDiagnostic,
  import: importHistory.status(),
  prompt: { mode: SYSTEM_PROMPT_MODE, chars: spawnedSystemPromptChars },
  window: {
    tokens: windowTokens, limit: activeWindowLimit, pct: windowPct(windowTokens, activeWindowLimit),
    autoCompactWindow: activeAutoCompactWindow,
    configuredAutoCompactWindow: CONFIGURED_AUTO_COMPACT_WINDOW,
    warnPct: WINDOW_WARN_PCT, warned: windowWarned,
    autoArchive: WINDOW_AUTO_ARCHIVE, archivePct: WINDOW_ARCHIVE_PCT,
    archiveTool: "hold", memoryWording: "affirmative-v2",
    archiveQueued: windowArchiveQueued, autoArchived: windowAutoArchived,
    compactHook: COMPACT_HOOK, summaryMode: process.env.COMPACT_SUMMARY_MODE || "safe",
    compactions, lastCompactAt: lastCompactAt ? new Date(lastCompactAt).toISOString() : null,
    lastCompactPreTokens: lastCompactPre || null,
  },
  recovery: {
    pending: procNeedsHistory,
    lastAt: lastRecoveryAt ? new Date(lastRecoveryAt).toISOString() : null,
    messages: lastRecoveryMessages, chars: lastRecoveryChars,
  },
  session: {
    enabled: SESSION_RESUME,
    idSuffix: nativeSessionId ? nativeSessionId.slice(-8) : null,
    resumed: nativeSessionResumed,
    confirmed: !!proc?.kelivoSessionConfirmed,
    recoveryMode: lastNativeRecoveryMode,
    recoveryAt: lastNativeRecoveryAt ? new Date(lastNativeRecoveryAt).toISOString() : null,
    freshModel: FRESH_SESSION_MODEL,
    awaitingFirstMessage: manualFreshPending,
  },
  stream: { heartbeatMs: SSE_HEARTBEAT_MS },
  delivery: {
    ...turnState.debug(),
    inflight: inflightTurns.size,
  },
  watchdog: {
    enabled: TURN_TIMEOUT_MS > 0,
    timeoutMs: TURN_TIMEOUT_MS,
    interruptGraceMs: TURN_INTERRUPT_GRACE_MS,
    active: !!turn,
    interruptPending: !!turn?.interruptRequestedAt,
    source: turn?.src || null,
    startedAt: turn?.startedAt ? new Date(turn.startedAt).toISOString() : null,
    lastActivityAt: turn?.lastActivityAt ? new Date(turn.lastActivityAt).toISOString() : null,
    lastTimeoutAt: lastTurnTimeoutAt ? new Date(lastTurnTimeoutAt).toISOString() : null,
    lastTimeoutSource: lastTurnTimeoutSource,
    lastInterruptAt: lastTurnInterruptAt ? new Date(lastTurnInterruptAt).toISOString() : null,
  },
  voice: { ready: voiceReady(), model: voiceCfg.modelId, settings: voiceSettingsOf(voiceCfg) },
  ears: { ready: earsReady(), auth: !!EARS_TOKEN },   // 语音消息能否听出语气
  stickers: { count: stickerNames().length },         // 表情包图库有几张
  wake: {
    bark: !!BARK_KEY,
    tg: !!TG_TOKEN, tgLocked: !!tgChatId,
    mode: wakeMode.get(),
    activeHoursSingapore: wakeMode.activeHours(),
    checkMin: WAKE_CHECK_MIN,
    idleMin: WAKE_IDLE_MIN,
    lastUserAt: new Date(lastUserAt).toISOString(),
    lastTurnAt: new Date(lastTurnAt).toISOString(),
    lastSpokeAt: lastSpokeAt ? new Date(lastSpokeAt).toISOString() : null,
  },
}));

// ---- 自主时间:定时唤醒,AI 自己决定说话还是静默续命 ----------------------------
// 默认只在新加坡时间 08:00-24:00 运行;手机管理页可热切换为 24 小时。距离上一轮
// 对话(任何 turn,含唤醒轮)超过 WAKE_IDLE_MIN 分钟才喂一条【系统·自主时间】:
//   想说话 → Bark 推送到手机(Kelivo 里看不到,但常驻进程自己记得,回来自然接上)
//   没话说 → 只回【沉默】。这仍是一轮真实 Claude 调用,所以保留进程/历史/
//            忙碌安全门,并默认约每 50-60 分钟一轮,尽量在一小时缓存过期前续上。
const BARK_KEY = process.env.BARK_KEY || "";
const WAKE_CHECK_MIN = +(process.env.WAKE_CHECK_MIN || 10); // 只检查本地状态,不会调用 Claude
const WAKE_IDLE_MIN = +(process.env.WAKE_IDLE_MIN || 50);   // 略小于一小时缓存 TTL
let lastUserAt = Date.now();
let lastTurnAt = Date.now();  // 任何一轮完成都会刷新缓存 TTL(handleEvent result 里更新)
let lastSpokeAt = 0;          // 上次真的主动开口(推送出去)的时刻

async function barkPush(text) {
  const r = await fetch("https://api.day.app/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_key: BARK_KEY, title: AI_NAME, body: text.slice(0, 1800), group: "ai-partner" }),
  });
  log("[bark]", r.status);
}
function wakeTurn(idleUserMin) {
  const now = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
  const sinceSpoke = lastSpokeAt
    ? `,你上次主动开口是约 ${Math.round((Date.now() - lastSpokeAt) / 60000)} 分钟前`
    : "";
  const canTg = !!(TG_TOKEN && tgChatId);
  const speakLine = canTg
    ? "想跟她说点什么就直接说——会直接出现在你们的 Telegram 对话里(她可能开着勿扰或在忙,别期待立刻回复);像随手发的微信,频率你自己把握。"
    : BARK_KEY
    ? "想跟她说点什么就直接说——会作为通知弹到她手机(Kelivo 里看不到这条,她回来时你自然接上,别解释机制;她可能开着勿扰或在忙,别期待立刻回复);说话像随手发的微信,频率你自己把握。"
    : "(当前没有配置推送渠道,说了她也收不到。)";
  const sink = {
    text() {}, thinking() {},
    finish(_u, fullText) {
      const t = (fullText || "").replace(/‖/g, "\n").trim();
      if (!t || t.includes("【沉默】")) { log("[wake] silent"); return; }
      lastSpokeAt = Date.now();
      if (canTg) tgSendReply(t).catch((e) => log("[tg-err]", e.message));
      else if (BARK_KEY) barkPush(t).catch((e) => log("[bark-err]", e.message));
    },
  };
  enqueue({
    text: `【系统·自主时间】现在新加坡时间 ${now},她已约 ${Math.round(idleUserMin)} 分钟没有消息${sinceSpoke}。这轮是留给你自己的:${speakLine}没什么想说的就只回【沉默】两个字,这轮只用来保持你的状态和记忆连续。`,
    images: [], system: spawnedSystem, sse: sink, newWindow: false, model: spawnedModel, src: "wake",
  });
}
function wakeTick(force) {
  const nowMs = Date.now();
  const idleTurnMs = nowMs - lastTurnAt;
  // A prepared official-chat move belongs to the next real Kelivo message.
  // Keep this explicit even though a normal prepare restart also has no
  // resident process, so future wake changes cannot steal the fresh session.
  if (importHistory.loadPending()) {
    const status = { triggered: false, reason: "import-pending" };
    log("[wake] skipped", status.reason);
    return status;
  }
  const status = autonomousWakeStatus({
    hasProcess: !!proc,
    busy,
    queueLength: queue.length,
    needsHistory: procNeedsHistory,
    idleTurnMs,
    idleThresholdMs: WAKE_IDLE_MIN * 60000,
    withinWakeWindow: wakeMode.allows(nowMs),
    force,
  });
  if (!status.triggered) {
    log("[wake] skipped", status.reason);
    return status;
  }
  const idleTurnMin = idleTurnMs / 60000;
  log("[wake] idle", Math.round(idleTurnMin), "min", force ? "(forced)" : "");
  wakeTurn((Date.now() - lastUserAt) / 60000);
  return status;
}
setInterval(wakeTick, WAKE_CHECK_MIN * 60000);
// 手动触发口(测试用):POST /hb?key=<SHIM_KEY>
app.post("/hb", (req, res) => {
  if (SHIM_KEY && (req.query.key || req.get("x-api-key")) !== SHIM_KEY) return res.status(401).json({ ok: false });
  const status = wakeTick(true);
  res.json({ ok: true, ...status });
});

// ---- 音色热更新:换音色/调参数不用重启(= 不换窗口) --------------------------
// GET  /voice?key=<SHIM_KEY>  看当前配置
// POST /voice?key=<SHIM_KEY>  {"voiceId":"...","speed":0.9,...} 改哪项传哪项,立即生效
// POST /voice/reset?key=...   丢弃覆盖,退回环境变量的配置
const voiceAuth = (req, res) =>
  !SHIM_KEY || (req.query.key || req.get("x-api-key")) === SHIM_KEY
    ? true : (res.status(401).json({ ok: false }), false);

app.get("/voice", (req, res) => {
  if (!voiceAuth(req, res)) return;
  res.json({ ok: true, ready: voiceReady(), cfg: voiceCfg, overridden: fs.existsSync(VOICE_CFG_FILE) });
});

app.post("/voice", (req, res) => {
  if (!voiceAuth(req, res)) return;
  const next = sanitizeVoiceCfg(req.body || {}, voiceCfg);
  try {
    fs.writeFileSync(VOICE_CFG_FILE, JSON.stringify(next, null, 2) + "\n");
  } catch (e) {
    // 卷不可写就只在内存生效:这轮能听到效果,但重启会丢——如实告知,别假装成功
    log("[voice] persist failed:", e.message);
    voiceCfg = next;
    return res.json({ ok: true, persisted: false, warning: "写入 /persona 失败,重启后失效", cfg: voiceCfg });
  }
  voiceCfg = next;
  log("[voice] updated:", JSON.stringify(voiceCfg));
  res.json({ ok: true, persisted: true, cfg: voiceCfg });
});

app.post("/voice/reset", (req, res) => {
  if (!voiceAuth(req, res)) return;
  try { fs.unlinkSync(VOICE_CFG_FILE); } catch { /* 本来就没有 */ }
  voiceCfg = envVoiceCfg();
  res.json({ ok: true, cfg: voiceCfg });
});

// ---- Telegram 前端(与 Kelivo 并行,同一个常驻进程=同一个他) --------------------
// 收消息走 submitTurn 同一条队列;回复与自主发言直接 sendMessage——
// Telegram bot 天生可主动开口,这是 Kelivo(纯请求-响应)做不到的。
// TG_BOT_TOKEN 启用;TG_CHAT_ID 可预设,不设则第一个私聊自动锁定(之后只认这一个人)。
const TG_TOKEN = process.env.TG_BOT_TOKEN || "";
let tgChatId = +(process.env.TG_CHAT_ID || 0);
let tgOffset = 0;

async function tgApi(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  return r.json();
}
const TG_THINKING = process.env.TG_THINKING !== "0"; // 思考链以折叠引用块发出,点开看;0 关闭
const tgEsc = (x) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
async function tgSendThinking(think) {
  if (!tgChatId || !think) return;
  // 可折叠引用块:默认收起一行,点开展开——等价于 Kelivo 的 reasoning 视图
  const body = think.length > 3600 ? think.slice(0, 3600) + "…" : think;
  const j = await tgApi("sendMessage", { chat_id: tgChatId, parse_mode: "HTML",
    text: `<blockquote expandable>${tgEsc(body)}</blockquote>` });
  if (!j.ok) log("[tg-think-err]", JSON.stringify(j).slice(0, 200));
}
async function tgSend(text) {
  if (!tgChatId || !text) return;
  for (let i = 0; i < text.length; i += 4000) {  // TG 单条上限 4096
    const j = await tgApi("sendMessage", { chat_id: tgChatId, text: text.slice(i, i + 4000) });
    if (!j.ok) log("[tg-send-err]", JSON.stringify(j).slice(0, 200));
  }
}
// 分气泡:按换行把一轮回复拆成多条消息,一行一个气泡,像真人连发微信。
// 气泡边界由 AI 自己的换行决定(人设本就习惯短句分行);上限防刷屏,超出并入最后一条。
const TG_SPLIT = process.env.TG_SPLIT !== "0";
const TG_SPLIT_MAX = +(process.env.TG_SPLIT_MAX || 8);
const tgSleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tgSendBubbles(text) {
  if (!tgChatId || !text) return;
  if (!TG_SPLIT) return tgSend(text);
  const lines = text.split("\n").map((x) => x.trim()).filter(Boolean);
  if (lines.length <= 1) return tgSend(text);
  const bubbles = lines.slice(0, TG_SPLIT_MAX);
  if (lines.length > TG_SPLIT_MAX) bubbles[TG_SPLIT_MAX - 1] = lines.slice(TG_SPLIT_MAX - 1).join("\n");
  for (let i = 0; i < bubbles.length; i++) {
    if (i) { // 第二条起:先亮"正在输入",按字数停顿,再发——手感像真人打字
      tgApi("sendChatAction", { chat_id: tgChatId, action: "typing" }).catch(() => {});
      await tgSleep(Math.min(500 + bubbles[i].length * 35, 2500));
    }
    await tgSend(bubbles[i]);
  }
}
// 语音:回复里 [语音]English content[/语音] 的段落转 ElevenLabs TTS,
// 以 Telegram 原生语音条(sendVoice)发出,与文字气泡按出现顺序混排。
// 未配 key/voice_id、额度耗尽、API 报错、转码失败 → 该段原样降级为文字,内容不丢。
const EL_KEY = process.env.ELEVENLABS_API_KEY || "";

// 音色与渲染配方:**运行时可改,不必重启**。
// 为什么要这样:改 Zeabur 环境变量会重启容器。而挑音色、调语速这种事
// 天然要反复试听微调,每试一次换一次窗口的代价无法接受。所以配置存在
// /persona/voice.json(持久卷,换容器不丢),用 POST /voice 热改,即时生效。
// 优先级:voice.json > 环境变量 > 代码默认。
// stability 低→语调起伏大更松弛;similarity 高→贴原始样本质感;style 高→磁性/玩味,过高会失控。
const clamp = (v, lo, hi, dflt) => {
  const n = +v;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const VOICE_CFG_FILE = "/persona/voice.json";

function envVoiceCfg() {
  return {
    voiceId: process.env.ELEVENLABS_VOICE_ID || "",
    modelId: process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2",
    speed: clamp(process.env.VOICE_SPEED, 0.7, 1.2, 0.85),
    stability: clamp(process.env.VOICE_STABILITY, 0, 1, 0.45),
    similarity_boost: clamp(process.env.VOICE_SIMILARITY, 0, 1, 0.95),
    style: clamp(process.env.VOICE_STYLE, 0, 1, 0.35),
    use_speaker_boost: process.env.VOICE_SPEAKER_BOOST !== "0",
  };
}

// 只认白名单字段并逐项夹到合法区间——避免把非法值写进去,下次开机就起不来。
function sanitizeVoiceCfg(patch, base) {
  const out = { ...base };
  if (typeof patch.voiceId === "string" && patch.voiceId.trim()) out.voiceId = patch.voiceId.trim();
  if (typeof patch.modelId === "string" && patch.modelId.trim()) out.modelId = patch.modelId.trim();
  if ("speed" in patch) out.speed = clamp(patch.speed, 0.7, 1.2, base.speed);
  if ("stability" in patch) out.stability = clamp(patch.stability, 0, 1, base.stability);
  if ("similarity_boost" in patch) out.similarity_boost = clamp(patch.similarity_boost, 0, 1, base.similarity_boost);
  if ("style" in patch) out.style = clamp(patch.style, 0, 1, base.style);
  if ("use_speaker_boost" in patch) out.use_speaker_boost = !!patch.use_speaker_boost;
  return out;
}

let voiceCfg = envVoiceCfg();
try {
  const saved = JSON.parse(fs.readFileSync(VOICE_CFG_FILE, "utf8"));
  voiceCfg = sanitizeVoiceCfg(saved, voiceCfg);
  log("[voice] loaded override from", VOICE_CFG_FILE, "voiceId=", voiceCfg.voiceId.slice(0, 6) + "…");
} catch { /* 没有覆盖文件就用 env,正常情况 */ }

const voiceSettingsOf = (c) => ({
  speed: c.speed, stability: c.stability, similarity_boost: c.similarity_boost,
  style: c.style, use_speaker_boost: c.use_speaker_boost,
});
const voiceReady = () => !!(EL_KEY && voiceCfg.voiceId);

async function tgSendVoice(ogg) {
  const fd = new FormData();
  fd.append("chat_id", String(tgChatId));
  fd.append("voice", new Blob([ogg], { type: "audio/ogg" }), "voice.ogg");
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendVoice`,
    { method: "POST", body: fd, signal: AbortSignal.timeout(60000) });
  const j = await r.json();
  if (!j.ok) throw new Error(`sendVoice: ${JSON.stringify(j).slice(0, 200)}`);
}

// ---- 表情包:回复里的 [贴纸:名字] 发成原生贴纸 --------------------------------
// 图库是私人内容,不进这个仓库:注册表与图都在持久卷上,没配就整个功能静默关闭
// (标记会原样显示成文字,聊天不受影响)。
// 用 sendSticker 不用 sendPhoto:sendPhoto 会被当"照片"整宽显示,占半个屏幕;
// sendSticker 才是聊天里小小一块的正经贴纸尺寸。
const STICKER_FILE = process.env.STICKER_REGISTRY || "/persona/stickers.json";
const STICKER_DIR = process.env.STICKER_DIR || "/persona/stickers";
let stickers = loadStickers(STICKER_FILE, log);
const stickerNames = () => Object.keys(stickers);
const hasSticker = (n) => !!stickers[n];

// 有 file_id 就直接发(秒发);没有就从卷上传一次 webp,把返回的 file_id 回写注册表——
// 之后重启/重部署都不必重传。上传失败不抛给聊天,只是这张没发出去。
async function tgSendSticker(name) {
  const e = stickers[name];
  if (!e) return false;
  if (e.file_id) {
    const j = await tgApi("sendSticker", { chat_id: tgChatId, sticker: e.file_id });
    if (j.ok) return true;
    log("[sticker-err]", name, JSON.stringify(j).slice(0, 160));
    if (!e.file) return false;
    delete e.file_id;                        // file_id 失效(换了 bot 等):退回重传一次
  }
  if (!e.file) return false;
  const p = path.join(STICKER_DIR, e.file);
  const fd = new FormData();
  fd.append("chat_id", String(tgChatId));
  fd.append("sticker", new Blob([fs.readFileSync(p)], { type: "image/webp" }), e.file);
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendSticker`,
    { method: "POST", body: fd, signal: AbortSignal.timeout(60000) });
  const j = await r.json();
  if (!j.ok) throw new Error(`sendSticker: ${JSON.stringify(j).slice(0, 200)}`);
  const fid = j.result?.sticker?.file_id;
  if (fid) { e.file_id = fid; saveStickers(STICKER_FILE, stickers, log); }
  return true;
}

// 一轮回复的统一出口:切语音/贴纸/文字段,按出现顺序发。
// 贴纸只在文字段里找——语音段的内容整段送 TTS,不该被解析。
async function tgSendReply(text) {
  if (!tgChatId || !text) return;
  const segs = [];
  for (const s of splitVoiceSegments(text)) {
    if (s.type === "text") segs.push(...splitStickerSegments(s.content, hasSticker));
    else segs.push(s);
  }
  for (const seg of segs) {
    if (!seg.content.trim()) continue;
    if (seg.type === "sticker") {
      try { if (await tgSendSticker(seg.content)) continue; }
      catch (e) { log("[sticker-err]", seg.content, e.message); }
      continue;                              // 发不出去就当没这张,不把标记吐给她看
    }
    if (seg.type === "voice" && voiceReady()) {
      try {
        tgApi("sendChatAction", { chat_id: tgChatId, action: "record_voice" }).catch(() => {});
        await tgSendVoice(await ttsOgg({
          text: seg.content, apiKey: EL_KEY, voiceId: voiceCfg.voiceId,
          modelId: voiceCfg.modelId, voiceSettings: voiceSettingsOf(voiceCfg), log,
        }));
        continue;
      } catch (e) { log("[voice-err]", e.message); } // 落到下面的文字降级
    }
    await tgSendBubbles(seg.content);
  }
}

async function tgFetchPhoto(m) {
  // 取最大尺寸的那张;下载转 base64 image block
  try {
    const ph = m.photo[m.photo.length - 1];
    const gf = await tgApi("getFile", { file_id: ph.file_id });
    if (!gf.ok) return null;
    const r = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${gf.result.file_path}`);
    const buf = Buffer.from(await r.arrayBuffer());
    return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } };
  } catch (e) { log("[tg-photo-err]", e.message); return null; }
}
async function tgFetchSticker(m) {
  // 贴纸/表情包:静态贴纸(webp)直接给图;动图(.tgs)/视频(.webm)贴纸没法当静图,
  // 退而取它的静态缩略图。都带上贴纸自带的 emoji 作情绪线索。Claude 视觉支持 webp。
  const s = m.sticker || {};
  const emoji = s.emoji || "";
  try {
    let fileId = null;
    if (!s.is_animated && !s.is_video) fileId = s.file_id;      // 静态贴纸本体
    else if (s.thumbnail) fileId = s.thumbnail.file_id;         // 动图/视频取缩略图
    if (!fileId) return { image: null, emoji };
    const gf = await tgApi("getFile", { file_id: fileId });
    if (!gf.ok) return { image: null, emoji };
    const path = gf.result.file_path || "";
    const r = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${path}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const mt = /\.png$/i.test(path) ? "image/png"
      : /\.jpe?g$/i.test(path) ? "image/jpeg" : "image/webp";
    return { image: { type: "image", source: { type: "base64", media_type: mt, data: buf.toString("base64") } }, emoji };
  } catch (e) { log("[tg-sticker-err]", e.message); return { image: null, emoji }; }
}
// ---- 语音消息:听见「怎么说的」,不只是「说了什么」 ----------------------------
// 她发来的语音条送去 ears 服务:转写 + 和她自己平时的声音比对(音量/停顿/语速…),
// 结果贴在这条消息上一起进窗口。ears 没配或挂了都只是少一层信息,消息本身不丢。
const EARS_URL = (process.env.EARS_URL || "").replace(/\/+$/, "");
const EARS_TOKEN = process.env.EARS_TOKEN || "";
const earsReady = () => !!EARS_URL;

async function tgFetchVoice(m) {
  const v = m.voice || m.audio || {};
  if (!v.file_id) return null;
  const gf = await tgApi("getFile", { file_id: v.file_id });
  if (!gf.ok) return null;
  const r = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${gf.result.file_path}`);
  return Buffer.from(await r.arrayBuffer());
}

async function earsListen(ogg) {
  const fd = new FormData();
  fd.append("file", new Blob([ogg], { type: "audio/ogg" }), "voice.ogg");
  const r = await fetch(`${EARS_URL}/api/listen`, {
    method: "POST", body: fd,
    headers: EARS_TOKEN ? { "X-Token": EARS_TOKEN } : {},   // ears 只认 X-Token,别改成 Bearer
    signal: AbortSignal.timeout(45000),                      // 转写+判断走两趟云端,给足时间
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// 把 ears 的结构化结果写成模型读得懂的一行。刻意不写成「系统指令」——
// 这是转述她的语音,不是命令模型做什么(2026-07-22 injection 事故的教训)。
function voiceLine(j) {
  const said = (j.text || "").trim();
  const rel = j.relative && Object.keys(j.relative).length
    ? Object.entries(j.relative).map(([k, v]) => k + v).join("、") : "";
  const bits = [j.emotion, j.hint, rel && `和她平时比:${rel}`].filter(Boolean);
  const tone = bits.length ? `(语气:${bits.join(",")})` : "";
  const learning = /^[0-7]\//.test(j.baseline_progress || "") ? "(还在熟悉她的声音)" : "";
  return said
    ? `[语音] ${said}${tone}${learning}`
    : `(她发来一条语音,但没听清内容${tone})`;
}

// ---- 收集模式:转发一个贴纸给 bot,下一句说「入库:名字」就记下来 ----------------
// Telegram 贴纸包里的贴纸导不出文件,但它的 file_id 可以直接复用——所以这条路
// 一张图都不用存,记个号就行,立即可用,不必重启也不必重部署。
// 「入库」这类管理动作**不进他的窗口**:她整理图库时他不该看见一堆莫名其妙的对话。
let pendingSticker = null;   // { file_id, emoji, at }
const INTAKE_RE = /^(?:入库|收录|存)\s*[:：]?\s*(.{1,32})$/;

async function stickerIntake(m, text) {
  if (m.sticker?.file_id && !m.sticker.is_animated && !m.sticker.is_video) {
    pendingSticker = { file_id: m.sticker.file_id, emoji: m.sticker.emoji || "", at: Date.now() };
  }
  if (!text) return false;
  if (/^贴纸清单$/.test(text)) {
    const n = stickerNames();
    await tgSend(n.length ? `图库里现在有 ${n.length} 张:\n${n.join("、")}` : "图库还是空的。");
    return true;
  }
  const del = /^(?:删除贴纸|删贴纸)\s*[:：]?\s*(.{1,32})$/.exec(text);
  if (del) {
    const name = del[1].trim();
    if (!stickers[name]) { await tgSend(`图库里没有「${name}」。`); return true; }
    delete stickers[name];
    saveStickers(STICKER_FILE, stickers, log);
    await tgSend(`已删掉「${name}」。`);
    return true;
  }
  const mm = INTAKE_RE.exec(text);
  if (!mm) return false;
  const name = mm[1].trim();
  if (!pendingSticker || Date.now() - pendingSticker.at > 10 * 60e3) {
    await tgSend("要先发一个贴纸过来,再说「入库:名字」。");
    return true;
  }
  stickers[name] = { file_id: pendingSticker.file_id, emoji: pendingSticker.emoji,
    added: new Date().toISOString().slice(0, 10) };
  const ok = saveStickers(STICKER_FILE, stickers, log);
  pendingSticker = null;
  await tgSend(ok ? `✅ 已入库:「${name}」(共 ${stickerNames().length} 张)`
                  : `⚠️ 「${name}」记下了,但没写进文件,重启会丢`);
  return true;
}

// GET /stickers?key=<SHIM_KEY> —— 看图库里有哪些名字(排查用;注册表本身在卷上)
app.get("/stickers", (req, res) => {
  if (!voiceAuth(req, res)) return;
  res.json({ ok: true, count: stickerNames().length, names: stickerNames(), file: STICKER_FILE });
});
// POST /stickers/reload?key=... —— 手工改过卷上的注册表后热加载,不必重启
app.post("/stickers/reload", (req, res) => {
  if (!voiceAuth(req, res)) return;
  stickers = loadStickers(STICKER_FILE, log);
  res.json({ ok: true, count: stickerNames().length, names: stickerNames() });
});

async function handleTgMessage(m) {
  if (!m.chat || m.chat.type !== "private") return;
  if (!tgChatId) { tgChatId = m.chat.id; log("[tg] chat locked:", tgChatId); }
  else if (m.chat.id !== tgChatId) return; // 单用户:只认锁定的那个人
  let text = (m.text || m.caption || "").trim();
  if (await stickerIntake(m, text)) return;   // 收集模式:给刚发的贴纸起个名,不进他的窗口
  const images = [];
  if (m.photo && m.photo.length) { const img = await tgFetchPhoto(m); if (img) images.push(img); }
  if (m.sticker) {
    const { image, emoji } = await tgFetchSticker(m);
    if (image) images.push(image);
    const note = `(她发来一个贴纸/表情包${emoji ? " " + emoji : ""}${image ? "——就是上面这张图" : ",但图没取到,只有这个表情符号"})`;
    text = text ? `${text}\n${note}` : note;
  }
  if (m.voice || m.audio) {
    // 转写要几秒,先让她看到「正在听」而不是干等
    tgApi("sendChatAction", { chat_id: tgChatId, action: "typing" }).catch(() => {});
    let note;
    if (!earsReady()) note = "(她发来一条语音——耳朵还没接上,我听不到内容)";
    else {
      try {
        const ogg = await tgFetchVoice(m);
        note = ogg ? voiceLine(await earsListen(ogg))
                   : "(她发来一条语音,但没能取到音频)";
      } catch (e) {
        log("[ears-err]", e.message);
        note = "(她发来一条语音,但这次没听清)";   // 降级:宁可少信息,不丢消息
      }
    }
    text = text ? `${text}\n${note}` : note;
  }
  if (!text && !images.length) return;
  // 生成回复期间维持「正在输入…」
  const typing = setInterval(() => tgApi("sendChatAction", { chat_id: tgChatId, action: "typing" }).catch(() => {}), 4500);
  tgApi("sendChatAction", { chat_id: tgChatId, action: "typing" }).catch(() => {});
  let think = "";
  const sink = {
    text() {}, thinking(t) { if (TG_THINKING) think += t; },
    finish(_u, fullText) {
      clearInterval(typing);
      const t = (fullText || "").replace(/‖/g, "\n").trim();
      (async () => {
        if (think.trim()) await tgSendThinking(think.trim());
        await tgSendReply(t || "…");
      })().catch((e) => log("[tg-err]", e.message));
    },
  };
  submitTurn(text, images, sink, { src: "telegram" });
}
async function tgPoll() {
  log("[tg] long-poll started");
  while (true) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?timeout=50&offset=${tgOffset}`,
        { signal: AbortSignal.timeout(65000) });
      const j = await r.json();
      if (j.ok) for (const u of j.result) {
        tgOffset = u.update_id + 1;
        if (u.message) await handleTgMessage(u.message);
      }
    } catch (e) {
      log("[tg-poll-err]", e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
if (TG_TOKEN) tgPoll();

// ---- Apple Watch 健康数据中转 --------------------------------------------------
// 手机快捷指令 POST 任意 JSON 到 /aw?key=<AW_KEY>;AI 用 WebFetch GET 同一地址读。
// 内存保存 48h / 最多 300 条,重启即清(实时数据,不当存储)。
const AW_KEY = process.env.AW_KEY || SHIM_KEY;
let awData = [];
function awAuth(req) {
  const k = req.query.key || req.get("x-api-key") || "";
  return !AW_KEY || k === AW_KEY;
}
app.post("/aw", (req, res) => {
  if (!awAuth(req)) return res.status(401).json({ ok: false });
  awData.push({ t: new Date().toISOString(), data: req.body });
  const cut = Date.now() - 48 * 3600e3;
  awData = awData.filter((x) => new Date(x.t).getTime() > cut).slice(-300);
  log("[aw] push", JSON.stringify(req.body).slice(0, 120));
  res.json({ ok: true, count: awData.length });
});
app.get("/aw", (req, res) => {
  if (!awAuth(req)) return res.status(401).json({ ok: false });
  // 去掉空字段/空条目(快捷指令调试期的垃圾推送),只给最近 12 条,免得 AI 读一大坨
  const cleaned = awData
    .map((x) => {
      const d = {};
      for (const [k, v] of Object.entries(x.data || {})) {
        const s = v == null ? "" : String(v).trim();
        if (s) d[k] = s;
      }
      return { t: x.t, data: d };
    })
    .filter((x) => Object.keys(x.data).length > 0);
  res.json({ now: new Date().toISOString(), count: cleaned.length, entries: cleaned.slice(-12) });
});

// Kelivo 的「模型」页拉这个列表来选模型。Anthropic /v1/models 格式。
function listModels(_req, res) {
  const now = new Date().toISOString();
  const data = MODELS.map((m) => ({
    type: "model", id: m,
    display_name: `${AI_NAME} (${m.replace(/^claude-/, "")})`,
    created_at: now,
  }));
  res.json({ data, has_more: false, first_id: MODELS[0], last_id: MODELS[MODELS.length - 1] });
}
app.get("/v1/models", listModels);
app.get("/models", listModels);

// ---- 真实时钟注入:每条消息开头盖新加坡时间戳 + 距上条消息的间隔 ------------------
// 常驻进程的系统提示里只有 spawn 当天的日期,窗口一活好几天,AI 对"现在几点/过了多久"
// 全靠猜——猜错就把错的时间写进记忆。把真实时钟直接喂到每条消息前,不用工具、不用猜。
// TIME_STAMP=0 关闭;间隔小于 TIME_GAP_MIN 分钟(默认5)时只给时间不啰嗦间隔。
const TIME_STAMP = process.env.TIME_STAMP !== "0";
const TIME_GAP_MIN = +(process.env.TIME_GAP_MIN || 5);
function fmtGap(min) {
  if (min < 60) return `${min}分钟`;
  if (min < 1440) { const h = Math.floor(min / 60), m = min % 60; return m ? `${h}小时${m}分` : `${h}小时`; }
  const d = Math.floor(min / 1440), h = Math.round((min % 1440) / 60);
  return h ? `${d}天${h}小时` : `${d}天`;
}
function timeStamp(prevUserAt) {
  const sg = new Date(Date.now() + 8 * 3600e3);
  const week = "日一二三四五六"[sg.getUTCDay()];
  let s = `【时间 ${sg.toISOString().slice(0, 16).replace("T", " ")} 周${week}`;
  const gap = Math.round((Date.now() - prevUserAt) / 60000);
  if (gap >= TIME_GAP_MIN) s += ` · 距上条消息约${fmtGap(gap)}`;
  return s + "】";
}

// 聊天内容永远不触发换 session。「换窗口」也只是她说给对方听的一句话,shim 不偷听成
// 运维命令。想换人由聊天外的操作完成(例如切换模型);日常故障则优先续接原 session。
// Kelivo 与 Telegram 共用的进队逻辑:时间戳 → enqueue
function submitTurn(text, images, sink, opts = {}) {
  // A prepared official-chat package owns the next native turn. No Telegram,
  // wake, archive or ordinary request may create the fresh process first.
  if (importHistory.loadPending()) {
    const warning = "⚠️〔搬家门正在等待〕请从准备好的空白 Kelivo 对话发送官端原本的下一句话。";
    log("[import] blocked a non-import turn", opts.src || "unknown");
    try { sink?.text?.(warning); } catch {}
    try { sink?.finish?.(undefined, warning); } catch {}
    return false;
  }
  const newWindow = false;
  if (TIME_STAMP) text = `${timeStamp(lastUserAt)}\n${text}`;
  lastUserAt = Date.now(); // 自主时间空闲计时基准
  log("[turn]", { src: opts.src || "kelivo", len: text.length, imgs: images.length });
  enqueue({
    text, images, system: opts.system ?? spawnedSystem, sse: sink, newWindow,
    model: opts.model || spawnedModel, recovery: opts.recovery, src: opts.src || "kelivo",
    requestKey: opts.requestKey || null,
  });
  return true;
}

function importEligible(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 2) return false;
  if (messages.at(-1)?.role !== "user") return false;
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const text = contentToText(lastUser?.content ?? "").trim();
  return !!text && !isKelivoTitleRequest(text);
}

function handleMessages(req, res) {
  if (shuttingDown) return res.status(503).json({
    type: "error", error: { type: "overloaded_error", message: "shim is restarting; retry shortly" },
  });
  if (SHIM_KEY) {
    const key = req.get("x-api-key") || (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (key !== SHIM_KEY) return res.status(401).json({ type: "error", error: { type: "authentication_error", message: "bad key" } });
  }
  const body = req.body || {};
  const currentMessages = (body.messages || []).filter((m) => m.role === "user" || m.role === "assistant");
  const lastUser = [...currentMessages].reverse().find((m) => m.role === "user");
  const text = contentToText(lastUser?.content ?? "");
  const stream = body.stream !== false;

  // Kelivo 的自动标题请求会退回当前聊天模型。它带着一份 <content> 历史，
  // 但不是用户消息；若送进常驻 claude，会污染上下文并重置心跳计时。
  // 在这里本地完成，既隔离 resident process，也省掉一次模型调用。
  if (isKelivoTitleRequest(text)) {
    const title = localTitleForRequest(text);
    const titleModel = MODELS.includes(body.model) ? body.model : spawnedModel;
    const sink = stream ? makeSSE(res, titleModel) : makeCollector(res, titleModel);
    const usage = { input_tokens: 0, output_tokens: Array.from(title).length };
    sink.text(title);
    sink.finish(usage, title);
    log("[title] handled locally", { title, requestChars: text.length });
    return;
  }

  const pendingImport = importHistory.loadPending();
  if (pendingImport && !importEligible(currentMessages)) {
    return res.status(409).json({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "A Claude chat import is waiting. Send the next message from a new, empty Kelivo chat.",
      },
    });
  }

  const images = extractImages(currentMessages);
  const system = systemToText(body.system);
  // Kelivo 选的模型;不在名单里(或没传)就沿用当前模型
  const model = MODELS.includes(body.model) ? body.model : spawnedModel;
  // Keep the request identity based on the actual Kelivo request. The imported
  // prefix is one-shot, but a phone reconnect must still reattach to or replay
  // the same first turn instead of submitting it a second time.
  const requestKey = requestFingerprint({ messages: currentMessages, system, model });
  const existing = inflightTurns.get(requestKey);
  if (existing) {
    const sse = stream ? makeSSE(res, model) : makeCollector(res, model);
    existing.add(sse);
    log("[delivery] identical request reattached to active turn", requestKey.slice(0, 8));
    return;
  }
  const missed = turnState.findReplay(requestKey);
  // A new import must not be mistaken for an older mailbox entry whose first
  // user sentence happens to be identical. Once the import is claimed, normal
  // reconnects use this mailbox path again.
  if (missed && !pendingImport) {
    const sse = stream ? makeSSE(res, model) : makeCollector(res, model);
    log("[delivery] replaying completed response from mailbox", requestKey.slice(0, 8));
    sse.text?.(missed.fullText);
    const delivered = sse.isConnected?.() !== false;
    sse.finish?.(missed.usage || undefined, missed.fullText);
    if (delivered) turnState.markReplayed(requestKey);
    return;
  }

  let imported = null;
  if (pendingImport) {
    imported = importHistory.consume(pendingImport.id);
    if (!imported) {
      return res.status(409).json({
        type: "error",
        error: { type: "conflict_error", message: "The pending Claude chat changed; reload the import page and try again." },
      });
    }
    res.setHeader("x-kelivo-imported-history", String(imported.messages.length));
    log("[import] consumed by fresh Kelivo chat", {
      messages: imported.messages.length,
      chars: imported.chars,
    });
  }

  const messages = imported ? [...imported.messages, ...currentMessages] : currentMessages;
  const recovery = recoveryTranscript(messages, {
    maxMessages: REHYDRATE_MAX_MESSAGES,
    maxChars: REHYDRATE_MAX_CHARS,
  });
  const sse = stream ? makeSSE(res, model) : makeCollector(res, model);
  const delivery = new ReplayableDelivery(sse);
  inflightTurns.set(requestKey, delivery);
  submitTurn(text, images, delivery, { system, model, src: "kelivo", recovery, requestKey });
}

// Kelivo 的 Claude 类型 Base URL 填 /v1 会拼成 /v1/messages;填根则是 /messages。两个都接。
app.post("/v1/messages", handleMessages);
app.post("/messages", handleMessages);

function finishShutdown() {
  if (shutdownFinishing) return;
  shutdownFinishing = true;
  if (shutdownTimer) clearTimeout(shutdownTimer);
  turnState.flush();
  const old = proc;
  proc = null;
  try { old?.kill("SIGTERM"); } catch {}
  const exitTimer = setTimeout(() => {
    try { if (old?.exitCode === null) old.kill("SIGKILL"); } catch {}
    process.exit(0);
  }, 1500);
  exitTimer.unref?.();
}

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("[shutdown] graceful stop requested", signal);
  httpServer.close(() => { if (!turn) finishShutdown(); });

  while (queue.length) {
    const item = queue.shift();
    try { item.sse?.text?.("⚠️〔服务正在重启〕这一轮尚未开始，请稍后重发。"); } catch {}
    try { item.sse?.finish?.(undefined, "⚠️〔服务正在重启〕这一轮尚未开始，请稍后重发。"); } catch {}
    if (item.requestKey) inflightTurns.delete(item.requestKey);
  }
  turnState.event("shutdown_requested", { signal });
  turnState.flush();

  if (!turn) return finishShutdown();
  turnWatchdog.disarm(turn);
  turn.interruptRequestedAt = Date.now();
  turnState.mark("interrupting", { reason: "graceful-shutdown" });
  try {
    if (proc?.stdin?.writable && !proc.stdin.destroyed) {
      proc.stdin.write(JSON.stringify(interruptControlRequest(randomUUID())) + "\n");
    }
  } catch {}
  shutdownTimer = setTimeout(finishShutdown, 20_000);
  shutdownTimer.unref?.();
}

const httpServer = app.listen(PORT, () =>
  log(`kelivo-shim on :${PORT} model=${MODEL} thinking=${FORWARD_THINKING}`));
process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.once("SIGINT", () => gracefulShutdown("SIGINT"));
