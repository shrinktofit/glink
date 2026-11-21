import type { ProjectDisableConfirmation } from '@glink/protocol/workspace';
import { WorkspaceError } from './workspace-error.ts';

export class ProjectDisableConfirmationError extends WorkspaceError {
  constructor(projectId: string, reasons: string[]) {
    super(`停用 Project 需要确认：${reasons.join('；')}`, 409);
    this.confirmation = { projectId, reasons };
  }

  readonly confirmation: ProjectDisableConfirmation;
}
