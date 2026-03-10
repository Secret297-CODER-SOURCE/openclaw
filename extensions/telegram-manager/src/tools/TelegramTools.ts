// Workspace file tools — each agent instance is scoped to its own directory,
// preventing cross-agent file access.
import fs from "fs";
import path from "path";

// Files the agent may read.
export const READABLE_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "MEMORY.md",
] as const;

// Files the agent may write (memory/context only — not behavioral instructions).
export const WRITABLE_FILES = ["MEMORY.md", "USER.md"] as const;

export type ReadableFile = (typeof READABLE_FILES)[number];
export type WritableFile = (typeof WRITABLE_FILES)[number];

export interface WorkspaceTools {
  workspaceDir: string;
  readFile(filename: ReadableFile): Promise<string>;
  writeFile(filename: WritableFile, content: string): Promise<void>;
}

/**
 * Create a WorkspaceTools instance scoped to a single agent's workspace directory.
 * All read/write operations are validated and confined to this directory — an agent
 * cannot reach another agent's files through these tools.
 */
export function createWorkspaceTools(workspaceDir: string): WorkspaceTools {
  return {
    workspaceDir,

    async readFile(filename: ReadableFile): Promise<string> {
      if (!(READABLE_FILES as readonly string[]).includes(filename)) return "";
      try {
        return await fs.promises.readFile(path.join(workspaceDir, filename), "utf-8");
      } catch {
        return "";
      }
    },

    async writeFile(filename: WritableFile, content: string): Promise<void> {
      if (!(WRITABLE_FILES as readonly string[]).includes(filename)) {
        throw new Error(
          `Write access denied for "${filename}"; allowed: ${WRITABLE_FILES.join(", ")}`,
        );
      }
      fs.mkdirSync(workspaceDir, { recursive: true });
      await fs.promises.writeFile(path.join(workspaceDir, filename), content, "utf-8");
    },
  };
}

/** Anthropic tool definitions for workspace file access. */
export const workspaceToolDefs = [
  {
    name: "read_workspace_file",
    description:
      "Read one of your workspace files (e.g. MEMORY.md, USER.md) to recall stored context from previous sessions.",
    input_schema: {
      type: "object" as const,
      properties: {
        filename: {
          type: "string" as const,
          enum: READABLE_FILES as unknown as string[],
          description: "The workspace file to read.",
        },
      },
      required: ["filename"],
    },
  },
  {
    name: "write_workspace_file",
    description:
      "Update MEMORY.md (to remember facts across sessions) or USER.md (to record context about the person you are talking with). Use this to persist important information so it is available in future conversations.",
    input_schema: {
      type: "object" as const,
      properties: {
        filename: {
          type: "string" as const,
          enum: WRITABLE_FILES as unknown as string[],
          description: "Which workspace file to update (MEMORY.md or USER.md).",
        },
        content: {
          type: "string" as const,
          description: "Full new content for the file.",
        },
      },
      required: ["filename", "content"],
    },
  },
] as const;
