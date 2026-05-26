import { stat } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { projectsRoot } from "../util/paths.ts";

/**
 * Session resolver — discovers session JSONL files across all projects.
 *
 * Layout assumption (verified by audit):
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/agent-*.jsonl  (sidechain)
 *
 * Important: sessionId is NOT unique across project dirs. When the user `cd`s
 * mid-session, Claude Code copies the JSONL into the new project dir. The
 * authoritative key for a session is `(projectDir, sessionId)`.
 */

export interface ProjectRef {
  /** Encoded cwd dir name, e.g. "-opt-my-project" */
  projectDir: string;
  /** Absolute path to the project dir */
  absolutePath: string;
}

export interface SessionRef {
  projectDir: string;
  sessionId: string;
  filePath: string;
  /** File size in bytes — proxy for session richness */
  sizeBytes: number;
  /** mtime (last write time) */
  modifiedAt: Date;
}

const JSONL_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

export async function listProjects(): Promise<ProjectRef[]> {
  const root = projectsRoot();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }

  const projects: ProjectRef[] = [];
  for (const entry of entries) {
    const absolutePath = join(root, entry);
    const s = await stat(absolutePath).catch(() => null);
    if (!s?.isDirectory()) continue;
    projects.push({ projectDir: entry, absolutePath });
  }
  return projects.sort((a, b) => a.projectDir.localeCompare(b.projectDir));
}

export async function listSessionsInProject(project: ProjectRef): Promise<SessionRef[]> {
  let entries: string[];
  try {
    entries = await readdir(project.absolutePath);
  } catch {
    return [];
  }

  const sessions: SessionRef[] = [];
  for (const entry of entries) {
    const match = JSONL_PATTERN.exec(entry);
    if (!match) continue;
    const sessionId = match[1] as string;
    const filePath = join(project.absolutePath, entry);
    const s = await stat(filePath).catch(() => null);
    if (!s?.isFile()) continue;
    sessions.push({
      projectDir: project.projectDir,
      sessionId,
      filePath,
      sizeBytes: s.size,
      modifiedAt: s.mtime,
    });
  }
  return sessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

export async function listAllSessions(): Promise<SessionRef[]> {
  const projects = await listProjects();
  const all = await Promise.all(projects.map(listSessionsInProject));
  return all.flat().sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

/**
 * Find a session by ID — searches all projects since sessionId is not unique
 * across project dirs.
 */
export async function findSessions(sessionId: string): Promise<SessionRef[]> {
  const all = await listAllSessions();
  return all.filter((s) => s.sessionId === sessionId);
}

/**
 * Find a session by ID within a specific project.
 */
export async function findSessionInProject(
  projectDir: string,
  sessionId: string,
): Promise<SessionRef | null> {
  const projects = await listProjects();
  const project = projects.find((p) => p.projectDir === projectDir);
  if (!project) return null;
  const sessions = await listSessionsInProject(project);
  return sessions.find((s) => s.sessionId === sessionId) ?? null;
}

/**
 * Helper: format a project dir name to a human-readable cwd guess.
 * Linux/macOS: "-opt-my-project" → "/opt/my-project"
 * Windows: "C--Users-me-proj" → "C:\Users\me\proj"
 *
 * Note: this is heuristic. The encoding is not perfectly reversible (multiple
 * dashes vs slashes are ambiguous). Use `cwd` from the first message event for
 * authoritative answer when available.
 */
export function projectDirToCwdGuess(projectDir: string, platform: "linux" | "win32"): string {
  if (platform === "win32") {
    return projectDir.replace(/^([A-Za-z])-/, "$1:\\").replace(/-/g, "\\");
  }
  return projectDir.replace(/^-/, "/").replace(/-/g, "/");
}

/**
 * Compact representation suitable for JSON output (Date → ISO string).
 */
export function serializeSessionRef(s: SessionRef): Record<string, unknown> {
  return {
    project: s.projectDir,
    sessionId: s.sessionId,
    file: s.filePath,
    sizeKB: Math.round(s.sizeBytes / 1024),
    modifiedAt: s.modifiedAt.toISOString(),
    filename: basename(s.filePath),
  };
}
