#!/usr/bin/env bash
# kelivo-shim runtime: install Claude Code if missing, wire OB memory, run the shim.
export DEBIAN_FRONTEND=noninteractive

# claude-code + gmail-mcp now come from package.json (installed at BUILD time by
# zbpack), so boot only needs the platform-native binary (postinstall is blocked by
# npm allowScripts). install.cjs downloads it; retry for network flakes.
CC_PKG="/src/node_modules/@anthropic-ai/claude-code"
[ -d "$CC_PKG" ] || CC_PKG="$(npm root -g)/@anthropic-ai/claude-code"
export CLAUDE_BIN="$CC_PKG/bin/claude.exe"
for i in 1 2 3 4 5; do
  if "$CLAUDE_BIN" --version >/dev/null 2>&1; then break; fi
  echo "[entrypoint] claude native binary missing, fetching (attempt $i)..."
  (cd "$CC_PKG" && node install.cjs) || true
  sleep 3
done
"$CLAUDE_BIN" --version || echo "[entrypoint] WARNING: claude still not runnable"

unset ANTHROPIC_API_KEY   # subscription channel must win

# 手机一次性授权页把新账号凭据写进 /persona 私有卷。环境变量仍优先；
# 没有环境变量时才从卷恢复，且绝不把令牌打印进日志。
CLAUDE_OAUTH_TOKEN_FILE="${CLAUDE_OAUTH_TOKEN_FILE:-/persona/claude-code-oauth-token}"
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -r "$CLAUDE_OAUTH_TOKEN_FILE" ]; then
  IFS= read -r CLAUDE_CODE_OAUTH_TOKEN < "$CLAUDE_OAUTH_TOKEN_FILE"
  case "$CLAUDE_CODE_OAUTH_TOKEN" in
    sk-ant-oat01-*)
      export CLAUDE_CODE_OAUTH_TOKEN
      echo "[entrypoint] restored direct Claude auth from private volume"
      ;;
    *)
      unset CLAUDE_CODE_OAUTH_TOKEN
      echo "[entrypoint] WARNING: ignored invalid Claude OAuth token file"
      ;;
  esac
fi

# 新账号直连保险:CLAUDE_CODE_OAUTH_TOKEN 是官方给 headless/自动环境使用的
# 订阅凭据。旧部署仍保留 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN 作为可审计
# 的历史配置,但 AUTH_TOKEN 的认证优先级更高;若不主动屏蔽,它会把请求送回旧代理。
# 只要新 token 已配置,就让直连订阅明确胜出,且日志绝不打印任何凭据。
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  unset ANTHROPIC_AUTH_TOKEN
  unset ANTHROPIC_BASE_URL
  echo "[entrypoint] direct Claude subscription auth selected"
fi

# Voice fallback transcoder: only needed if ElevenLabs can't serve Ogg/Opus
# directly (plan-gated formats) — then mp3 gets transcoded via ffmpeg.
# Install is best-effort; without it opus-direct still works.
if [ -n "$ELEVENLABS_API_KEY" ] && ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[entrypoint] installing ffmpeg (voice mp3 fallback)..."
  (apt-get update -qq && apt-get install -y -qq --no-install-recommends ffmpeg) \
    || echo "[entrypoint] ffmpeg install failed; voice works only if opus-direct is available"
fi

# Gmail OAuth 正本在持久卷。过去先复制到 /src、再复制到 ~/.gmail-mcp；同一容器
# 重启时 /src 的旧副本仍在，便会盖回刚换好的邮箱令牌。现在直接把 Gmail MCP 的
# 官方路径环境变量指向 /persona，彻底取消多层副本竞态。只有完整的一对文件才启用，
# 避免 OAuth 客户端和令牌来自不同目录。
GMAIL_PERSONA_DIR="${GMAIL_PERSONA_DIR:-/persona/gmail-auth}"
GMAIL_BUNDLED_DIR="${GMAIL_BUNDLED_DIR:-/src/gmail-auth}"
if [ -f "$GMAIL_PERSONA_DIR/gcp-oauth.keys.json" ] && [ -f "$GMAIL_PERSONA_DIR/credentials.json" ]; then
  export GMAIL_OAUTH_PATH="$GMAIL_PERSONA_DIR/gcp-oauth.keys.json"
  export GMAIL_CREDENTIALS_PATH="$GMAIL_PERSONA_DIR/credentials.json"
  echo "[entrypoint] Gmail MCP reads verified credentials directly from private volume"
elif [ -f "$GMAIL_BUNDLED_DIR/gcp-oauth.keys.json" ] && [ -f "$GMAIL_BUNDLED_DIR/credentials.json" ]; then
  # 兼容没有 /persona 持久卷的上游部署；本项目线上不会走到这里。
  export GMAIL_OAUTH_PATH="$GMAIL_BUNDLED_DIR/gcp-oauth.keys.json"
  export GMAIL_CREDENTIALS_PATH="$GMAIL_BUNDLED_DIR/credentials.json"
  echo "[entrypoint] Gmail MCP reads bundled credentials"
else
  echo "[entrypoint] Gmail MCP credentials incomplete; keeping package defaults"
fi

# MCP config:优先从 /persona 保险箱恢复真实配置(2026-07-22 事故:换容器后 /src 丢失
# 手工放的真实 .mcp.json,下面的占位符兜底顶上 → 沈渡所有 MCP 工具断连。真实配置含
# 私人域名/token 引用,不能进公开仓库,所以正本存 /persona 卷,这里开机恢复。)
if [ ! -f .mcp.json ] && [ -f /persona/.mcp.json ]; then
  cp /persona/.mcp.json .mcp.json && echo "[entrypoint] restored .mcp.json from /persona"
fi
# 一次性清理(2026-07-25):mochi 服务已删除,把配置里的 mochi 条目摘掉,顺手把
# /persona 正本也治好(用 node 解析 JSON 改,不用 sed 抠文本)。条目不在就什么都不做,
# 将来 /persona 已是干净版时这段等于空转,可在下次整理 entrypoint 时移除。
for mf in .mcp.json /persona/.mcp.json; do
  [ -f "$mf" ] || continue
  node -e '
    const fs = require("fs"), p = process.argv[1];
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    if (j.mcpServers && j.mcpServers.mochi) {
      delete j.mcpServers.mochi;
      fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
      console.log("[entrypoint] removed retired mochi entry from " + p);
    }' "$mf" || true
done
# 最后兜底:占位符模板(只应在全新环境出现;线上见到它=保险箱丢了,去 /persona 查)
if [ ! -f .mcp.json ]; then
  cat > .mcp.json <<'JSON'
{ "mcpServers": {
  "ombre": { "type": "http", "url": "https://<你的记忆MCP域名>/mcp" },
  "fish":  { "type": "http", "url": "https://<你的其他MCP域名>/mcp" },
  "gmail": { "command": "npx", "args": ["-y", "@gongrzhe/server-gmail-autoauth-mcp"] }
} }
JSON
fi

# 啵啵鸟 MCP:真实 URL(含私密路径)只放在 Zeabur 的 BIRD_MCP_URL 环境变量里。
# 启动时合并进运行配置,并同步回 /persona 保险箱;日志不打印 URL。
if [ -n "${BIRD_MCP_URL:-}" ]; then
  if ! node -e '
    const fs = require("fs");
    const source = ".mcp.json";
    const raw = process.env.BIRD_MCP_URL || "";
    const url = new URL(raw);
    if (url.protocol !== "https:") throw new Error("BIRD_MCP_URL must use https");
    const j = JSON.parse(fs.readFileSync(source, "utf8"));
    j.mcpServers ||= {};
    delete j.mcpServers.bird;
    j.mcpServers.toy = { type: "http", url: raw };
    const next = JSON.stringify(j, null, 2) + "\n";
    fs.writeFileSync(source, next);
    if (fs.existsSync("/persona")) fs.writeFileSync("/persona/.mcp.json", next);
  '; then
    echo "[entrypoint] ERROR: invalid BIRD_MCP_URL or MCP config"
    exit 1
  fi
  echo "[entrypoint] toy MCP configured"
fi

# --- 人设保险箱:根治白板 ------------------------------------------------------
# 沈渡的人设(CLAUDE.md / profile-instructions.md / 渡-self-prompt-v5.md 等)存在持久卷
# /persona 里。/src 是容器临时盘,换新容器/重建就没了——所以开机时若 /src 缺某个人设文件,
# 就从 /persona 卷自动补齐。加了这段之后,任何重启/部署/换新容器都不会再把沈渡打成白板,
# 也不需要任何人工干预。
#
# 【给未来维护者(含新开的 CC 会话)的提示】
#   · 人设"正本"永远在 /persona 卷里,这里是唯一真源。
#   · 要改人设,就改 /persona 里对应的文件(`zeabur service exec` 进容器改,或改后放回卷),
#     重启后本段会自动把它复印进 /src 生效。
#   · 绝对不要把人设文件提交进本仓库——kelivo-shim 是公开 OSS。人设靠 .gitignore 挡在仓库外,
#     靠 /persona 卷持久化,靠这段自动恢复。三者缺一,就可能白板或泄露。
if [ -d /persona ]; then
  for f in /persona/*.md; do
    [ -e "$f" ] || continue
    bn=$(basename "$f")
    if [ ! -f "/src/$bn" ]; then
      cp "$f" "/src/$bn" && echo "[entrypoint] restored persona from /persona: $bn"
    fi
  done
fi

# Claude Code 原生会话保全:CLI 的 transcript 默认写在 ~/.claude/projects,
# 但容器根盘会随重建消失。把这一目录接到 /persona 持久卷后,shim 即使被看门狗
# 重启、进程崩溃或容器滚动更新,也能用 `claude --resume <session-id>` 续接原会话。
# 若镜像启动阶段已经产生过 projects,先做可恢复备份再接入,不静默删除。
if [ -d /persona ]; then
  CLAUDE_STATE_HOME="${HOME:-/root}/.claude"
  PERSISTENT_CLAUDE_STATE="/persona/claude-state"
  mkdir -p "$CLAUDE_STATE_HOME" "$PERSISTENT_CLAUDE_STATE/projects"
  if [ ! -e "$CLAUDE_STATE_HOME/projects" ]; then
    ln -s "$PERSISTENT_CLAUDE_STATE/projects" "$CLAUDE_STATE_HOME/projects"
  elif [ -d "$CLAUDE_STATE_HOME/projects" ] && [ ! -L "$CLAUDE_STATE_HOME/projects" ]; then
    cp -a "$CLAUDE_STATE_HOME/projects/." "$PERSISTENT_CLAUDE_STATE/projects/" 2>/dev/null || true
    mv "$CLAUDE_STATE_HOME/projects" "$CLAUDE_STATE_HOME/projects.pre-persist.$$"
    ln -s "$PERSISTENT_CLAUDE_STATE/projects" "$CLAUDE_STATE_HOME/projects"
  fi
  export SESSION_STATE_FILE="${SESSION_STATE_FILE:-$PERSISTENT_CLAUDE_STATE/shim-session.json}"
fi

# Trust the workspace so CLAUDE.md loads cleanly (permissions come from --allowedTools).
printf '%s' '{"hasCompletedOnboarding":true,"projects":{"/src":{"hasTrustDialogAccepted":true,"hasCompletedProjectOnboarding":true}}}' > "${HOME:-/root}/.claude.json"

exec node server.js
