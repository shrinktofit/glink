import type { ChangesSnapshot } from '@glink/protocol/git';
import { GitIndexTransaction } from '../git/worktree.ts';
import type { WorkspaceStore } from './workspace-store.ts';
import {
  applyProjectEnablementStatus,
  readDisabledSubmodulePointers,
} from './project-enablement.ts';

/** Read current workspace policy inside the same index reservation as the mutation. */
export async function changeWorkspaceIndex(
  store: WorkspaceStore,
  workspaceId: string,
  projectId: string,
  change: (
    index: GitIndexTransaction,
    blockers: ReadonlyMap<string, Error>,
  ) => Promise<ChangesSnapshot>,
) {
  const initial = store.project(await store.get(workspaceId), projectId);
  return GitIndexTransaction.run(initial.worktreePath, async (index) => {
    const document = await store.get(workspaceId);
    const project = store.project(document, projectId);
    const blockers = await readDisabledSubmodulePointers(project,
      document.projects.filter((child) => !child.enabled));
    const state = await change(index, blockers);
    return {
      ...applyProjectEnablementStatus(project, state, blockers),
      projectId,
      baselineCommit: project.baseline?.commit,
    };
  });
}
