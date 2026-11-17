export class WorkspaceError extends Error {
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }

  readonly status: number;
}
