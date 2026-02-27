import { html, nothing } from "lit";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface ObsSession {
  id: string;
  file: string;
  startTime: string;
  lastActivity: string;
  model: string | null;
  provider: string | null;
  channel: string | null;
  messageCount: number;
  tokenUsage: { input: number; output: number; cacheRead: number; total: number };
  cost: number;
  subAgents: Array<{ task: string; model: string | null; timestamp: string }>;
}

export interface ObsCommand {
  sessionId: string;
  sessionFile: string;
  timestamp: string;
  toolName: string;
  args: string;
  resultPreview: string;
}

export interface ObsTranscriptEntry {
  type: string;
  timestamp: string;
  content?: string;
  toolName?: string;
  toolArgs?: string;
  result?: string;
  role?: string;
}

export interface ObsMemoryFile {
  file: string;
  modifiedAt: string;
  sizeBytes: number;
}

export interface ObsGitChange {
  hash: string;
  message: string;
  timestamp: string;
}

export interface ObsProps {
  loading: boolean;
  error: string | null;
  sessions: ObsSession[];
  commands: ObsCommand[];
  memoryDirs: Record<string, ObsMemoryFile[]>;
  memoryChanges: ObsGitChange[];
  selectedSession: string | null;
  transcript: ObsTranscriptEntry[];
  transcriptLoading: boolean;
  selectedMemFile: string | null;
  memFileContent: string | null;
  expandedCmds: Set<string>;
  onRefresh: () => void;
  onSelectSession: (file: string | null) => void;
  onSelectMemFile: (path: string | null) => void;
  onToggleCmd: (key: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function relTime(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60_000) {
    return "now";
  }
  if (d < 3_600_000) {
    return `${Math.floor(d / 60_000)}m`;
  }
  if (d < 86_400_000) {
    return `${Math.floor(d / 3_600_000)}h`;
  }
  return `${Math.floor(d / 86_400_000)}d`;
}

function fmtTokens(n: number): string {
  if (n >= 1e6) {
    return `${(n / 1e6).toFixed(1)}M`;
  }
  if (n >= 1e3) {
    return `${(n / 1e3).toFixed(1)}K`;
  }
  return String(n);
}

function fmtCost(c: number): string {
  if (c === 0) {
    return "$0";
  }
  if (c < 0.01) {
    return `$${c.toFixed(4)}`;
  }
  return `$${c.toFixed(2)}`;
}

function timeOnly(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(11, 19);
  } catch {
    return iso;
  }
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) + "…" : id;
}

function toolColor(name: string): string {
  if (name === "exec" || name === "process") {
    return "#60a5fa";
  }
  if (name === "read" || name === "write" || name === "edit") {
    return "#34d399";
  }
  if (name === "web_search" || name === "web_fetch") {
    return "#a78bfa";
  }
  if (name === "message") {
    return "#fb923c";
  }
  if (name === "sessions_spawn" || name === "subagents") {
    return "#f472b6";
  }
  if (name === "browser") {
    return "#fbbf24";
  }
  return "#94a3b8";
}

// ---------------------------------------------------------------------------
// Styles (inline <style> inside the template, matching existing UI patterns)
// ---------------------------------------------------------------------------
const STYLES = html`
  <style>
    .obs {
      font-family: "SF Mono", "Fira Code", "JetBrains Mono", monospace;
      max-width: 1400px;
      margin: 0 auto;
    }
    .obs-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(155px, 1fr));
      gap: 0.6rem;
      margin-bottom: 1rem;
    }
    .obs-stat {
      background: var(--card-bg, #1e293b);
      border: 1px solid var(--card-border, #334155);
      border-radius: 8px;
      padding: 0.6rem 0.8rem;
    }
    .obs-stat-label {
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted, #94a3b8);
    }
    .obs-stat-val {
      font-size: 1.35rem;
      font-weight: 700;
    }
    .obs-panel {
      background: var(--card-bg, #1e293b);
      border: 1px solid var(--card-border, #334155);
      border-radius: 8px;
      margin-bottom: 0.75rem;
      overflow: hidden;
    }
    .obs-panel-hdr {
      padding: 0.5rem 0.875rem;
      border-bottom: 1px solid var(--card-border, #334155);
      font-weight: 600;
      font-size: 0.8rem;
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }
    .obs-panel-hdr .close {
      margin-left: auto;
      cursor: pointer;
      color: var(--text-muted, #64748b);
      font-size: 0.7rem;
    }
    .obs-panel-body {
      max-height: 400px;
      overflow-y: auto;
    }
    .obs-panel-body.tall {
      max-height: 600px;
    }
    .obs-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.75rem;
    }
    @media (max-width: 900px) {
      .obs-grid {
        grid-template-columns: 1fr;
      }
    }

    .obs-cmd {
      display: grid;
      grid-template-columns: 62px auto 1fr 55px;
      gap: 0.4rem;
      padding: 0.25rem 0.875rem;
      border-bottom: 1px solid rgba(51, 65, 85, 0.4);
      font-size: 0.72rem;
      align-items: center;
      cursor: pointer;
    }
    .obs-cmd:hover {
      background: rgba(51, 65, 85, 0.2);
    }
    .obs-cmd-time {
      color: var(--text-muted, #64748b);
    }
    .obs-cmd-tool {
      font-weight: 600;
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 0.68rem;
    }
    .obs-cmd-args {
      color: var(--text-muted, #94a3b8);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .obs-cmd-sid {
      color: var(--text-muted, #64748b);
      font-size: 0.6rem;
      text-align: right;
    }
    .obs-cmd-detail {
      padding: 0.4rem 0.875rem;
      background: rgba(15, 23, 42, 0.6);
      border-bottom: 1px solid rgba(51, 65, 85, 0.4);
      font-size: 0.68rem;
    }
    .obs-cmd-detail .lbl {
      color: var(--text-muted, #64748b);
      margin-bottom: 0.1rem;
    }
    .obs-cmd-detail pre {
      margin: 0.1rem 0 0.4rem;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 180px;
      overflow-y: auto;
    }

    .obs-sess {
      padding: 0.4rem 0.875rem;
      border-bottom: 1px solid rgba(51, 65, 85, 0.4);
      cursor: pointer;
    }
    .obs-sess:hover,
    .obs-sess.active {
      background: rgba(51, 65, 85, 0.2);
    }
    .obs-sess-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.78rem;
    }
    .obs-sess-id {
      font-weight: 600;
    }
    .obs-sess-meta {
      font-size: 0.68rem;
      color: var(--text-muted, #94a3b8);
      display: flex;
      gap: 0.6rem;
      margin-top: 0.1rem;
      flex-wrap: wrap;
    }
    .obs-sess-subs {
      margin-top: 0.25rem;
      padding-left: 0.6rem;
      border-left: 2px solid #f472b6;
    }
    .obs-sub {
      font-size: 0.68rem;
      color: var(--text-muted, #94a3b8);
      padding: 0.05rem 0;
    }
    .obs-sub-task {
      color: #f472b6;
    }

    .obs-tx {
      padding: 0.25rem 0.875rem;
      border-bottom: 1px solid rgba(51, 65, 85, 0.25);
      font-size: 0.72rem;
    }
    .obs-tx-role {
      font-weight: 600;
      font-size: 0.62rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 0.05rem;
    }
    .obs-tx-role.user {
      color: #60a5fa;
    }
    .obs-tx-role.assistant {
      color: #34d399;
    }
    .obs-tx-role.tool_call {
      color: #fbbf24;
    }
    .obs-tx-role.tool_result {
      color: #94a3b8;
    }
    .obs-tx-role.system {
      color: #a78bfa;
    }
    .obs-tx-role.model_change {
      color: #fb923c;
    }
    .obs-tx-content {
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 120px;
      overflow-y: auto;
      color: var(--text-muted, #cbd5e1);
    }

    .obs-mem-dir {
      padding: 0.3rem 0.875rem;
      border-bottom: 1px solid rgba(51, 65, 85, 0.4);
    }
    .obs-mem-dir-name {
      font-weight: 600;
      font-size: 0.78rem;
      margin-bottom: 0.1rem;
    }
    .obs-mem-file {
      font-size: 0.68rem;
      padding: 0.05rem 0 0.05rem 0.6rem;
      color: var(--text-muted, #94a3b8);
      cursor: pointer;
    }
    .obs-mem-file:hover {
      color: #60a5fa;
    }
    .obs-mem-file .meta {
      color: var(--text-muted, #64748b);
      font-size: 0.6rem;
      margin-left: 0.3rem;
    }
    .obs-mem-content {
      padding: 0.5rem 0.875rem;
      font-size: 0.68rem;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 350px;
      overflow-y: auto;
    }
    .obs-mem-back {
      padding: 0.4rem 0.875rem;
      border-bottom: 1px solid var(--card-border, #334155);
      font-size: 0.7rem;
    }
    .obs-git {
      padding: 0.4rem 0.875rem;
    }
    .obs-git-row {
      font-size: 0.68rem;
      padding: 0.05rem 0;
      display: flex;
      gap: 0.4rem;
    }
    .obs-git-hash {
      color: #60a5fa;
      font-weight: 600;
    }
    .obs-git-msg {
      color: var(--text-muted, #94a3b8);
      flex: 1;
    }
    .obs-git-time {
      color: var(--text-muted, #64748b);
      font-size: 0.6rem;
    }
    .obs-empty {
      padding: 1.5rem 0.875rem;
      text-align: center;
      color: var(--text-muted, #64748b);
      font-size: 0.78rem;
    }
  </style>
`;

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
export function renderObservability(props: ObsProps) {
  const {
    loading: _loading,
    error,
    sessions,
    commands,
    memoryDirs,
    memoryChanges,
    selectedSession,
    transcript,
    transcriptLoading,
    selectedMemFile,
    memFileContent,
    expandedCmds,
    onRefresh: _onRefresh,
    onSelectSession,
    onSelectMemFile,
    onToggleCmd,
  } = props;

  const totalTokens = sessions.reduce((a, s) => a + s.tokenUsage.total, 0);
  const totalCost = sessions.reduce((a, s) => a + s.cost, 0);
  const memFiles = Object.values(memoryDirs).reduce((a, f) => a + f.length, 0);

  return html`
    ${STYLES}
    <div class="obs">
      ${error ? html`<div style="color:#f87171;padding:0.5rem 0;font-size:0.8rem">${error}</div>` : nothing}

      <div class="obs-stats">
        <div class="obs-stat"><div class="obs-stat-label">Sessions</div><div class="obs-stat-val">${sessions.length}</div></div>
        <div class="obs-stat"><div class="obs-stat-label">Commands</div><div class="obs-stat-val">${commands.length}</div></div>
        <div class="obs-stat"><div class="obs-stat-label">Tokens</div><div class="obs-stat-val">${fmtTokens(totalTokens)}</div></div>
        <div class="obs-stat"><div class="obs-stat-label">Cost</div><div class="obs-stat-val">${fmtCost(totalCost)}</div></div>
        <div class="obs-stat"><div class="obs-stat-label">Memory</div><div class="obs-stat-val">${memFiles}</div></div>
      </div>

      <!-- Command stream -->
      <div class="obs-panel">
        <div class="obs-panel-hdr">⚡ Command Stream</div>
        <div class="obs-panel-body">
          ${
            commands.length === 0
              ? html`
                  <div class="obs-empty">No commands recorded</div>
                `
              : commands.slice(0, 100).map((c) => {
                  const key = `${c.timestamp}-${c.toolName}-${c.sessionId}`;
                  const exp = expandedCmds.has(key);
                  const color = toolColor(c.toolName);
                  return html`
                  <div class="obs-cmd" @click=${() => onToggleCmd(key)}>
                    <span class="obs-cmd-time">${timeOnly(c.timestamp)}</span>
                    <span class="obs-cmd-tool" style="background:${color}22;color:${color}">${c.toolName}</span>
                    <span class="obs-cmd-args">${c.args.slice(0, 140)}</span>
                    <span class="obs-cmd-sid">${shortId(c.sessionId)}</span>
                  </div>
                  ${
                    exp
                      ? html`<div class="obs-cmd-detail">
                        <div class="lbl">Arguments:</div><pre>${c.args}</pre>
                        ${c.resultPreview ? html`<div class="lbl">Result:</div><pre>${c.resultPreview}</pre>` : nothing}
                      </div>`
                      : nothing
                  }
                `;
                })
          }
        </div>
      </div>

      <div class="obs-grid">
        <!-- Sessions -->
        <div class="obs-panel">
          <div class="obs-panel-hdr">📡 Sessions</div>
          <div class="obs-panel-body">
            ${
              sessions.length === 0
                ? html`
                    <div class="obs-empty">No sessions</div>
                  `
                : sessions.map(
                    (s) => html`
                    <div
                      class="obs-sess ${selectedSession === s.file ? "active" : ""}"
                      @click=${() => onSelectSession(selectedSession === s.file ? null : s.file)}
                    >
                      <div class="obs-sess-top">
                        <span class="obs-sess-id">${shortId(s.id)}</span>
                        <span style="font-size:0.68rem;color:var(--text-muted,#94a3b8)">${relTime(s.lastActivity)}</span>
                      </div>
                      <div class="obs-sess-meta">
                        ${s.model ? html`<span>🤖 ${s.model}</span>` : nothing}
                        ${s.channel ? html`<span>📱 ${s.channel}</span>` : nothing}
                        <span>💬 ${s.messageCount}</span>
                        <span>🪙 ${fmtTokens(s.tokenUsage.total)}</span>
                        ${s.cost > 0 ? html`<span>💰 ${fmtCost(s.cost)}</span>` : nothing}
                      </div>
                      ${
                        s.subAgents.length > 0
                          ? html`<div class="obs-sess-subs">${s.subAgents.map(
                              (sa) =>
                                html`<div class="obs-sub"><span class="obs-sub-task">🤖 ${sa.task}</span>${sa.model ? html` <span style="color:#64748b">(${sa.model})</span>` : nothing}</div>`,
                            )}</div>`
                          : nothing
                      }
                    </div>
                  `,
                  )
            }
          </div>
        </div>

        <!-- Memory -->
        <div class="obs-panel">
          <div class="obs-panel-hdr">🧠 Memory</div>
          <div class="obs-panel-body">
            ${
              selectedMemFile && memFileContent !== null
                ? html`
                  <div class="obs-mem-back">
                    <a style="cursor:pointer;color:#60a5fa" @click=${() => onSelectMemFile(null)}>← Back</a>
                    <strong style="margin-left:0.4rem">${selectedMemFile}</strong>
                  </div>
                  <div class="obs-mem-content">${memFileContent}</div>
                `
                : html`
                  ${Object.entries(memoryDirs).map(
                    ([dir, files]) => html`
                      <div class="obs-mem-dir">
                        <div class="obs-mem-dir-name">📁 ${dir}/ (${files.length})</div>
                        ${files.slice(0, 10).map(
                          (f) => html`
                            <div class="obs-mem-file" @click=${() => onSelectMemFile(`${dir}/${f.file}`)}>
                              ${f.file}<span class="meta">${relTime(f.modifiedAt)}</span>
                            </div>
                          `,
                        )}
                        ${files.length > 10 ? html`<div class="obs-mem-file" style="color:#64748b">+${files.length - 10} more…</div>` : nothing}
                      </div>
                    `,
                  )}
                  ${
                    memoryChanges.length > 0
                      ? html`
                        <div style="padding:0.5rem 0.875rem;border-top:1px solid var(--card-border,#334155);font-weight:600;font-size:0.78rem">Recent Commits</div>
                        <div class="obs-git">
                          ${memoryChanges
                            .slice(0, 10)
                            .map(
                              (c) =>
                                html`<div class="obs-git-row"><span class="obs-git-hash">${c.hash}</span><span class="obs-git-msg">${c.message}</span><span class="obs-git-time">${relTime(c.timestamp)}</span></div>`,
                            )}
                        </div>
                      `
                      : nothing
                  }
                `
            }
          </div>
        </div>
      </div>

      <!-- Transcript -->
      ${
        selectedSession
          ? html`
            <div class="obs-panel">
              <div class="obs-panel-hdr">
                📜 Transcript — ${selectedSession}
                <span class="close" @click=${() => onSelectSession(null)}>✕ close</span>
              </div>
              <div class="obs-panel-body tall">
                ${
                  transcriptLoading
                    ? html`
                        <div class="obs-empty">Loading…</div>
                      `
                    : transcript.length === 0
                      ? html`
                          <div class="obs-empty">Empty transcript</div>
                        `
                      : transcript.map(
                          (e) => html`
                          <div class="obs-tx">
                            <div class="obs-tx-role ${e.type}">
                              ${timeOnly(e.timestamp)} — ${e.type}${e.toolName ? html` [${e.toolName}]` : nothing}
                            </div>
                            <div class="obs-tx-content">${e.content ?? e.toolArgs ?? e.result ?? ""}</div>
                          </div>
                        `,
                        )
                }
              </div>
            </div>
          `
          : nothing
      }
    </div>
  `;
}
