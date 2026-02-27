/**
 * Controller for the Observability tab.
 * Fetches data from the HTTP API at /__openclaw/api/observability/*.
 */

export type ObservabilityState = {
  obsLoading: boolean;
  obsError: string | null;
  obsSessions: Array<Record<string, unknown>>;
  obsCommands: Array<Record<string, unknown>>;
  obsMemoryDirs: Record<string, Array<Record<string, unknown>>>;
  obsMemoryChanges: Array<Record<string, unknown>>;
  obsSelectedSession: string | null;
  obsTranscript: Array<Record<string, unknown>>;
  obsTranscriptLoading: boolean;
  obsSelectedMemFile: string | null;
  obsMemFileContent: string | null;
  obsExpandedCmds: Set<string>;
};

const API_BASE = "/__openclaw/api/observability";

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(API_BASE + path);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function loadObservability(state: ObservabilityState): Promise<void> {
  if (state.obsLoading) {
    return;
  }
  state.obsLoading = true;
  state.obsError = null;
  try {
    const [sessData, cmdData, memData] = await Promise.all([
      fetchJson<{ sessions: Array<Record<string, unknown>> }>("/sessions"),
      fetchJson<{ commands: Array<Record<string, unknown>> }>("/commands"),
      fetchJson<{
        directories: Record<string, Array<Record<string, unknown>>>;
        recentChanges: Array<Record<string, unknown>>;
      }>("/memory"),
    ]);
    state.obsSessions = sessData.sessions ?? [];
    state.obsCommands = cmdData.commands ?? [];
    state.obsMemoryDirs = memData.directories ?? {};
    state.obsMemoryChanges = memData.recentChanges ?? [];

    // Refresh transcript if a session is selected
    if (state.obsSelectedSession) {
      const txData = await fetchJson<{ entries: Array<Record<string, unknown>> }>(
        `/session/${encodeURIComponent(state.obsSelectedSession)}/transcript`,
      );
      state.obsTranscript = txData.entries ?? [];
    }
  } catch (err) {
    state.obsError = String(err);
  } finally {
    state.obsLoading = false;
  }
}

export async function loadObsTranscript(state: ObservabilityState, file: string): Promise<void> {
  state.obsSelectedSession = file;
  state.obsTranscript = [];
  state.obsTranscriptLoading = true;
  try {
    const data = await fetchJson<{ entries: Array<Record<string, unknown>> }>(
      `/session/${encodeURIComponent(file)}/transcript`,
    );
    state.obsTranscript = data.entries ?? [];
  } catch {
    state.obsTranscript = [];
  } finally {
    state.obsTranscriptLoading = false;
  }
}

export async function loadObsMemFile(state: ObservabilityState, filePath: string): Promise<void> {
  state.obsSelectedMemFile = filePath;
  state.obsMemFileContent = null;
  try {
    const data = await fetchJson<{ content: string }>(
      `/memory/file/${encodeURIComponent(filePath)}`,
    );
    state.obsMemFileContent = data.content ?? "(empty)";
  } catch {
    state.obsMemFileContent = "(failed to load)";
  }
}
