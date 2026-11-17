import { z } from 'zod';
import { GitRevisionKind } from './git';
import {
  type WorkspaceDocument,
  type WorkspaceSummary,
} from './workspace';

export const toolsPath = '/api/tools';

export enum GlinkToolName {
  listWorkspaces = 'list_workspaces',
  getWorkspace = 'get_workspace',
  createWorkspace = 'create_workspace',
  removeWorkspace = 'remove_workspace',
  addProject = 'add_project',
  removeProject = 'remove_project',
  updateProject = 'update_project',
  syncWorkspace = 'sync_workspace',
}

export enum ToolAccess {
  read = 'read',
  write = 'write',
}

export interface ToolDefinition {
  description: string;
  access: ToolAccess;
  inputSchema: z.ZodObject;
}

const identifier = z.string().min(1);

const workspaceId = {
  workspaceId: identifier,
};

const projectId = {
  ...workspaceId,
  projectId: identifier,
};

const binding = z.strictObject({
  kind: z.enum(GitRevisionKind),
  revision: z.string().trim().min(1),
});

/** Transport-independent declarations; loading the catalog performs no I/O. */
export const workspaceTools = {
  [GlinkToolName.listWorkspaces]: {
    description: 'List registered Glink workspaces with IDs, names and project counts. Read-only.',
    access: ToolAccess.read,
    inputSchema: z.strictObject({}),
  },

  [GlinkToolName.getWorkspace]: {
    description: 'Read saved projects, paths, pinned baselines (commit and optional source ref), '
      + 'associations, Settled states '
      + 'and dependencies. Does not refresh Git status or synchronize submodules; '
      + 'use sync_workspace explicitly.',
    access: ToolAccess.read,
    inputSchema: z.strictObject(workspaceId),
  },

  [GlinkToolName.createWorkspace]: {
    description: 'Create a Glink workspace from existing worktrees. Automatically includes '
      + 'their submodules. Does not create Git worktrees or branches.',
    access: ToolAccess.write,
    inputSchema: z.strictObject({
      name: z.string().trim().min(1),
      worktreePaths: z.array(z.string().min(1)),
      dependencies: z.array(
        z.strictObject({
          fromPath: z.string().min(1),
          toPath: z.string().min(1),
        }),
      ).optional(),
    }),
  },

  [GlinkToolName.removeWorkspace]: {
    description: 'Remove a Glink workspace configuration. '
      + 'Keeps every Git repository and worktree on disk.',
    access: ToolAccess.write,
    inputSchema: z.strictObject(workspaceId),
  },

  [GlinkToolName.addProject]: {
    description: 'Add an existing worktree to a workspace, including its submodules. '
      + 'Optional parentId establishes a manual dependency from that project to the added project.',
    access: ToolAccess.write,
    inputSchema: z.strictObject({
      ...workspaceId,
      worktreePath: z.string().min(1),
      parentId: identifier.optional(),
    }),
  },

  [GlinkToolName.removeProject]: {
    description: 'Remove a project and its incident dependency edges from the workspace only. '
      + 'Does not delete files. A submodule project cannot be removed before its parent.',
    access: ToolAccess.write,
    inputSchema: z.strictObject(projectId),
  },

  [GlinkToolName.updateProject]: {
    description: 'Atomically patch only supplied Glink project fields. '
      + 'Association changes do not checkout Git. Named associations use full refs/heads/, '
      + 'refs/remotes/ or refs/tags/ names. '
      + 'baseline pins a commit SHA with an optional source ref; '
      + 'it never follows that ref automatically. Use null to clear baseline. '
      + 'manualDependencyIds replaces manual outgoing '
      + 'dependencies; automatic submodule edges stay.',
    access: ToolAccess.write,
    inputSchema: z.strictObject({
      ...projectId,
      changes: z.strictObject({
        name: z.string().trim().min(1).optional(),
        settled: z.boolean().optional(),
        baseline: z.strictObject({
          commit: z.string().trim().regex(/^[a-f0-9]{4,64}$/i),
          ref: z.string().trim().min(1).optional(),
        }).nullable().optional(),
        binding: binding.optional(),
        manualDependencyIds: z.array(identifier).optional(),
      }).refine(
        (value) => Object.keys(value).length > 0,
        'Supply at least one project field.',
      ),
    }),
  },

  [GlinkToolName.syncWorkspace]: {
    description: 'Discover and persist automatic submodule projects and dependency edges '
      + 'in a workspace. Does not checkout, stage, commit, clean or delete worktrees.',
    access: ToolAccess.write,
    inputSchema: z.strictObject(workspaceId),
  },
} satisfies Record<GlinkToolName, ToolDefinition>;

export type ToolInput<Name extends GlinkToolName> = z.output<
  (typeof workspaceTools)[Name]['inputSchema']
>;

export interface ToolResults {
  [GlinkToolName.listWorkspaces]: {
    workspaces: WorkspaceSummary[];
  };
  [GlinkToolName.getWorkspace]: WorkspaceDocument;
  [GlinkToolName.createWorkspace]: WorkspaceDocument;
  [GlinkToolName.removeWorkspace]: {
    workspaceId: string;
    removed: true;
  };
  [GlinkToolName.addProject]: WorkspaceDocument;
  [GlinkToolName.removeProject]: WorkspaceDocument;
  [GlinkToolName.updateProject]: WorkspaceDocument;
  [GlinkToolName.syncWorkspace]: WorkspaceDocument;
}

export interface ToolErrorResponse {
  error: string;
}
