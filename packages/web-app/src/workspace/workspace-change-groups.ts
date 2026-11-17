import type { WorkspaceProject, WorkspaceProjectStatus } from '@glink/protocol/workspace';

/** Keep project filtering and display order shared by rendering and index navigation. */
export function workspaceChangeGroups(
  projects: readonly WorkspaceProject[],
  statuses: readonly WorkspaceProjectStatus[],
  projectIds: readonly string[],
  staged: boolean,
) {
  const selected = new Set(projectIds);
  return projects.filter((project) => selected.has(project.id))
    .map((project) => {
      const status = statuses.find((state) => state.projectId === project.id);
      return {
        project,
        error: status?.error,
        files: (staged ? status?.staged : status?.unstaged) ?? [],
      };
    })
    .filter((group) => group.files.length || (!staged && group.error));
}
