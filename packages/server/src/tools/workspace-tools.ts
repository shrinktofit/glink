import {
  GlinkToolName,
  workspaceTools,
  type ToolInput,
  type ToolResults,
} from '@glink/protocol/tools';
import { WorkspaceError, type WorkspaceStore } from '../workspace/workspace-store.ts';

function parseToolInput<Name extends GlinkToolName>(
  name: Name,
  input: unknown,
): ToolInput<Name> {
  const parsed = workspaceTools[name].inputSchema.safeParse(input);

  if (!parsed.success) {
    throw new WorkspaceError(parsed.error.message);
  }

  return parsed.data as ToolInput<Name>;
}

/** Executes workspace operations inside the backend's existing store and write queue. */
export async function executeWorkspaceTool(
  store: WorkspaceStore,
  name: string,
  input: unknown,
): Promise<ToolResults[GlinkToolName]> {
  if (!Object.hasOwn(workspaceTools, name)) {
    throw new WorkspaceError('Tool not found.', 404);
  }

  const toolName = name as GlinkToolName;

  switch (toolName) {
  case GlinkToolName.listWorkspaces: {
    parseToolInput(toolName, input);
    const catalog = await store.catalog();

    return {
      workspaces: catalog.workspaces,
    };
  }

  case GlinkToolName.getWorkspace: {
    const args = parseToolInput(toolName, input);
    return store.get(args.workspaceId);
  }

  case GlinkToolName.createWorkspace: {
    const args = parseToolInput(toolName, input);
    return store.create(args);
  }

  case GlinkToolName.removeWorkspace: {
    const args = parseToolInput(toolName, input);
    await store.remove(args.workspaceId);

    return {
      workspaceId: args.workspaceId,
      removed: true,
    };
  }

  case GlinkToolName.addProject: {
    const args = parseToolInput(toolName, input);

    return store.addProject(
      args.workspaceId,
      args.worktreePath,
      args.parentId,
    );
  }

  case GlinkToolName.removeProject: {
    const args = parseToolInput(toolName, input);
    return store.removeProject(args.workspaceId, args.projectId);
  }

  case GlinkToolName.updateProject: {
    const args = parseToolInput(toolName, input);

    return store.patchProject(
      args.workspaceId,
      args.projectId,
      args.changes,
    );
  }

  case GlinkToolName.syncWorkspace: {
    const args = parseToolInput(toolName, input);
    return store.synchronize(args.workspaceId);
  }
  }
}
