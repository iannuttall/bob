import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "../config/types";

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

export type RunContext = {
  project: string | null;
  branch: string | null;
};

/**
 * Resolve the working directory for a run based on project/branch context.
 */
export function resolveRunCwd(
  context: RunContext | null,
  projects: Map<string, ProjectConfig>,
): string | null {
  if (!context?.project) {
    return null;
  }

  const project = projects.get(context.project);
  if (!project) {
    throw new WorktreeError(`Unknown project: ${context.project}`);
  }

  if (!context.branch) {
    return project.path;
  }

  const branch = sanitizeBranch(context.branch);
  if (matchesProjectBranch(project.path, branch)) {
    return project.path;
  }

  return ensureWorktree(project, branch);
}

/**
 * Ensure a worktree exists for the given project and branch.
 * Creates it if necessary.
 */
export function ensureWorktree(project: ProjectConfig, branch: string): string {
  const root = project.path;
  if (!existsSync(root)) {
    throw new WorktreeError(`Project path not found: ${root}`);
  }

  branch = sanitizeBranch(branch);
  const worktreesRoot = project.worktreesRoot;
  const worktreePath = path.join(worktreesRoot, branch);

  ensureWithinRoot(worktreesRoot, worktreePath);

  if (existsSync(worktreePath)) {
    if (!gitIsWorktree(worktreePath)) {
      throw new WorktreeError(`${worktreePath} exists but is not a git worktree`);
    }
    return worktreePath;
  }

  mkdirSync(worktreesRoot, { recursive: true });

  // Check if branch exists locally
  if (gitOk(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root)) {
    gitWorktreeAdd(root, worktreePath, branch);
    return worktreePath;
  }

  // Check if branch exists on origin
  if (gitOk(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], root)) {
    gitWorktreeAdd(root, worktreePath, branch, {
      baseRef: `origin/${branch}`,
      createBranch: true,
    });
    return worktreePath;
  }

  // Create new branch from default base
  const base = resolveDefaultBase(root);
  if (!base) {
    throw new WorktreeError("Cannot determine base branch for new worktree");
  }

  gitWorktreeAdd(root, worktreePath, branch, {
    baseRef: base,
    createBranch: true,
  });
  return worktreePath;
}

function gitWorktreeAdd(
  root: string,
  worktreePath: string,
  branch: string,
  options?: { baseRef?: string; createBranch?: boolean },
): void {
  const { baseRef, createBranch } = options ?? {};

  let args: string[];
  if (createBranch) {
    if (!baseRef) {
      throw new WorktreeError("Missing base ref for worktree creation");
    }
    args = ["worktree", "add", "-b", branch, worktreePath, baseRef];
  } else {
    args = ["worktree", "add", worktreePath, branch];
  }

  try {
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
    throw new WorktreeError(stderr.trim() || "git worktree add failed");
  }
}

function sanitizeBranch(branch: string): string {
  const cleaned = branch.trim();
  if (!cleaned) {
    throw new WorktreeError("Branch name cannot be empty");
  }
  if (cleaned.startsWith("/")) {
    throw new WorktreeError("Branch name cannot start with '/'");
  }
  const parts = cleaned.split("/");
  for (const part of parts) {
    if (part === "..") {
      throw new WorktreeError("Branch name cannot contain '..'");
    }
  }
  return cleaned;
}

function matchesProjectBranch(root: string, branch: string): boolean {
  const current = gitStdout(["branch", "--show-current"], root);
  return current === branch;
}

function ensureWithinRoot(root: string, targetPath: string): void {
  const rootResolved = path.resolve(root);
  const pathResolved = path.resolve(targetPath);
  if (!pathResolved.startsWith(rootResolved + path.sep) && pathResolved !== rootResolved) {
    throw new WorktreeError("Branch path escapes the worktrees directory");
  }
}

function gitIsWorktree(cwd: string): boolean {
  try {
    const result = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim() === "true";
  } catch {
    return false;
  }
}

function gitOk(args: string[], cwd: string): boolean {
  try {
    execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function gitStdout(args: string[], cwd: string): string | null {
  try {
    const result = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

function resolveDefaultBase(cwd: string): string | null {
  // Try main, then master
  if (gitOk(["show-ref", "--verify", "--quiet", "refs/heads/main"], cwd)) {
    return "main";
  }
  if (gitOk(["show-ref", "--verify", "--quiet", "refs/heads/master"], cwd)) {
    return "master";
  }

  // Try remotes
  if (gitOk(["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"], cwd)) {
    return "origin/main";
  }
  if (gitOk(["show-ref", "--verify", "--quiet", "refs/remotes/origin/master"], cwd)) {
    return "origin/master";
  }

  return null;
}
