export class GitIndexLockedError extends Error {
  constructor(lockPath: string) {
    super(`暂存区已被锁定（index.lock）。请等待其他 Git 操作结束，或检查残留锁文件。\n${lockPath}`);
  }
}
