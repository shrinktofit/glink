import type { ProjectDisableConfirmation } from '@glink/protocol/workspace';

export class ProjectDisableConfirmationError extends Error {
  constructor(message: string, confirmation: ProjectDisableConfirmation) {
    super(message);
    this.confirmation = confirmation;
  }

  readonly confirmation: ProjectDisableConfirmation;
}
