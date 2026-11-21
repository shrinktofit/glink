import { GitRevisionKind } from '@glink/protocol/git';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parse, stringify } from 'yaml';
import {
  WorkspaceConnectionKind,
  type CreateWorkspaceInput,
  type GlinkCatalog,
  type GlinkState,
  type UpdateProjectInput,
  type PatchProjectInput,
  type WorkspaceDocument,
  type WorkspaceProject,
  type ProjectBaseline,
} from '@glink/protocol/workspace';
import {
  hasWorktree,
  inspectWorktree,
} from './workspace-git.ts';
import { checkReferenceName, readCommitSha, readReferenceCommit } from './project-references.ts';
import { WorkspaceError } from './workspace-error.ts';
import { withProjectDisableCheck } from './project-enablement.ts';
import { ProjectDisableConfirmationError } from './project-disable-confirmation-error.ts';

function isBaseline(value: unknown): value is ProjectBaseline {
  const baseline = value as ProjectBaseline | undefined;
  return !!baseline && typeof baseline.commit === 'string'
    && /^[a-f0-9]{4,64}$/i.test(baseline.commit)
    && (baseline.ref === undefined || typeof baseline.ref === 'string');
}

function validateGraph(document: WorkspaceDocument) {
  const ids = new Set(document.projects.map((project) => project.id));
  const paths = new Set(document.projects.map((project) => project.worktreePath.toLowerCase()));
  if (ids.size !== document.projects.length || paths.size !== ids.size) {
    throw new WorkspaceError('Each worktree must have exactly one project in a workspace.');
  }
  const completed = new Set<string>();
  const visiting = new Set<string>();

  function visit(id: string) {
    if (visiting.has(id)) {
      throw new WorkspaceError('Dependencies must not form a cycle.');
    }
    if (completed.has(id)) {
      return;
    }
    visiting.add(id);
    for (const edge of document.connections.filter((edge) => edge.from === id)) {
      if (!ids.has(edge.to)) {
        throw new WorkspaceError('Dependency project does not exist.');
      }
      visit(edge.to);
    }
    visiting.delete(id);
    completed.add(id);
  }

  for (const edge of document.connections) {
    if (!ids.has(edge.from)) {
      throw new WorkspaceError('Dependency project does not exist.');
    }
  }
  document.projects.forEach((project) => visit(project.id));
}

function validateDocument(value: unknown): asserts value is WorkspaceDocument {
  const doc = value as WorkspaceDocument | undefined;
  if (
    doc?.version !== 3
    || typeof doc.id !== 'string'
    || typeof doc.name !== 'string'
    || !Array.isArray(doc.projects)
    || !Array.isArray(doc.connections)
  ) {
    throw new WorkspaceError('Invalid workspace YAML document.');
  }
  for (const project of doc.projects) {
    if (
      !project
      || typeof project.id !== 'string'
      || typeof project.name !== 'string'
      || typeof project.worktreePath !== 'string'
      || typeof project.settled !== 'boolean'
      || typeof project.enabled !== 'boolean'
      || (project.baseline !== undefined && !isBaseline(project.baseline))
      || !project.binding
      || !Object.values(GitRevisionKind).includes(project.binding.kind)
      || typeof project.binding.revision !== 'string'
    ) {
      throw new WorkspaceError('Invalid project in workspace YAML document.');
    }
  }
  for (const edge of doc.connections) {
    if (
      !edge
      || typeof edge.from !== 'string'
      || typeof edge.to !== 'string'
      || !Object.values(WorkspaceConnectionKind).includes(edge.kind)
    ) {
      throw new WorkspaceError('Invalid connection in workspace YAML document.');
    }
  }
  validateGraph(doc);
}

export class WorkspaceStore {
  static async open(home: string) {
    await mkdir(join(home, 'workspaces'), { recursive: true });
    const store = new WorkspaceStore(home);
    try {
      await store.catalog();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      await writeFile(join(home, 'state.yaml'), stringify({ version: 1, workspaces: [] }), {
        flag: 'wx',
      });
    }
    return store;
  }

  readonly home: string;

  async catalog(): Promise<GlinkCatalog> {
    const state = parse(await readFile(join(this.home, 'state.yaml'), 'utf8')) as GlinkState;
    if (
      state?.version !== 1
      || !Array.isArray(state.workspaces)
      || state.workspaces.some(
        (entry) =>
          !entry
          || typeof entry.id !== 'string'
          || entry.fileName !== `${entry.id}.glink-workspace.yaml`
          || typeof entry.name !== 'string',
      )
    ) {
      throw new WorkspaceError('Invalid Glink state.yaml.');
    }
    return { ...state, home: this.home };
  }

  async get(id: string): Promise<WorkspaceDocument> {
    const state = await this.catalog();
    const entry = state.workspaces.find((entry) => entry.id === id);
    if (!entry) {
      throw new WorkspaceError('Workspace not found.', 404);
    }
    const document: unknown = parse(
      await readFile(join(this.home, 'workspaces', entry.fileName), 'utf8'),
    );
    validateDocument(document);
    if (document.id !== id) {
      throw new WorkspaceError('Workspace identity does not match state.yaml.');
    }
    return document;
  }

  create(input: CreateWorkspaceInput) {
    return this.mutate(async () => {
      if (
        typeof input.name !== 'string'
        || !input.name.trim()
        || !Array.isArray(input.worktreePaths)
        || input.worktreePaths.some((path) => typeof path !== 'string')
      ) {
        throw new WorkspaceError('A workspace name and worktree paths are required.');
      }
      const catalog = await this.catalog();
      if (catalog.workspaces.some((workspace) => workspace.name === input.name.trim())) {
        throw new WorkspaceError('工作区名称已存在，请使用其他名称。', 409);
      }
      const now = new Date().toISOString();
      const document: WorkspaceDocument = {
        version: 3,
        id: randomUUID(),
        name: input.name.trim(),
        createdAt: now,
        updatedAt: now,
        projects: [],
        connections: [],
      };
      for (const path of input.worktreePaths) {
        await this._addWorktree(document, path);
      }
      for (const edge of input.dependencies ?? []) {
        const from = this._projectByPath(document, edge.fromPath);
        const to = this._projectByPath(document, edge.toPath);
        if (
          !document.connections.some(
            (connection) => connection.from === from.id && connection.to === to.id,
          )
        ) {
          document.connections.push({
            from: from.id,
            to: to.id,
            kind: WorkspaceConnectionKind.manual,
          });
        }
      }
      validateGraph(document);
      await this._save(document);
      return document;
    });
  }

  synchronize(id: string) {
    return this.mutate(async () => {
      const document = await this.get(id);
      const previous = JSON.stringify([document.projects, document.connections]);
      for (const project of document.projects) {
        if (!(await hasWorktree(project.worktreePath))) {
          continue;
        }
        const info = await inspectWorktree(project.worktreePath);
        const children: string[] = [];
        for (const submodule of info.submodules) {
          const child = await this._addWorktree(
            document,
            join(project.worktreePath, submodule.path),
            submodule.sha,
          );
          children.push(child.id);
        }
        document.connections = document.connections.filter(
          (edge) =>
            edge.from !== project.id
            || (edge.kind !== WorkspaceConnectionKind.submodule && !children.includes(edge.to)),
        );
        document.connections.push(
          ...children.map((to) => ({
            from: project.id,
            to,
            kind: WorkspaceConnectionKind.submodule,
          })),
        );
      }
      validateGraph(document);
      if (previous !== JSON.stringify([document.projects, document.connections])) {
        await this._save(document);
      }
      return document;
    });
  }

  addProject(id: string, path: string, parentId?: string) {
    return this.mutate(async () => {
      if (typeof path !== 'string' || !path.trim()) {
        throw new WorkspaceError('A worktree path is required.');
      }
      const document = await this.get(id);
      const project = await this._addWorktree(document, path);
      if (parentId) {
        this.project(document, parentId);
        if (
          !document.connections.some((edge) => edge.from === parentId && edge.to === project.id)
        ) {
          document.connections.push({
            from: parentId,
            to: project.id,
            kind: WorkspaceConnectionKind.manual,
          });
        }
      }
      validateGraph(document);
      await this._save(document);
      return document;
    });
  }

  updateProject(
    id: string,
    projectId: string,
    input: UpdateProjectInput,
  ) {
    return this.mutate(async () => {
      const document = await this.get(id);

      return this._applyProjectUpdate(document, projectId, input);
    });
  }

  patchProject(
    id: string,
    projectId: string,
    patch: PatchProjectInput,
  ) {
    return this.mutate(async () => {
      const document = await this.get(id);
      const project = this.project(document, projectId);
      const {
        enabled,
        confirmDisable,
        manualDependencyIds,
        baseline,
        ...values
      } = patch;
      if ((enabled !== undefined && typeof enabled !== 'boolean')
        || (confirmDisable !== undefined
          && (typeof confirmDisable !== 'boolean' || enabled !== false))) {
        throw new WorkspaceError('Invalid Project enabled state.');
      }
      const dependencies = document.connections.filter((edge) => edge.from === projectId);

      const dependencyIds = manualDependencyIds === undefined
        ? dependencies.map((edge) => edge.to)
        : [
          ...dependencies
            .filter((edge) => edge.kind === WorkspaceConnectionKind.submodule)
            .map((edge) => edge.to),
          ...manualDependencyIds,
        ];

      const save = async () => {
        if (enabled !== undefined) {
          project.enabled = enabled;
        }
        return this._applyProjectUpdate(document, projectId, {
          name: project.name,
          settled: project.settled,
          baseline: baseline === null ? undefined : baseline ?? project.baseline,
          binding: project.binding,
          ...values,
          dependencyIds,
        });
      };
      if (project.enabled && enabled === false) {
        return withProjectDisableCheck(document, project, async (reasons) => {
          if (reasons.length && !confirmDisable) {
            throw new ProjectDisableConfirmationError(project.id, reasons);
          }
          return save();
        });
      }
      return save();
    });
  }

  removeProject(id: string, projectId: string) {
    return this.mutate(async () => {
      const document = await this.get(id);
      this.project(document, projectId);
      if (
        document.connections.some(
          (edge) => edge.to === projectId && edge.kind === WorkspaceConnectionKind.submodule,
        )
      ) {
        throw new WorkspaceError('Remove the parent project before its submodule project.', 409);
      }
      document.projects = document.projects.filter((project) => project.id !== projectId);
      document.connections = document.connections.filter(
        (edge) => edge.from !== projectId && edge.to !== projectId,
      );
      await this._save(document);
      return document;
    });
  }

  /** Caller holds mutate(); persist only projects whose disk deletion has completed. */
  async forgetDeletedWorktrees(document: WorkspaceDocument, paths: readonly string[]) {
    const roots = paths.map((path) => path.replaceAll('\\', '/').toLowerCase());
    const removed = new Set(document.projects.filter((project) => {
      const path = project.worktreePath.replaceAll('\\', '/').toLowerCase();
      return roots.some((root) => path === root || path.startsWith(`${root}/`));
    }).map((project) => project.id));
    if (!removed.size) {
      return;
    }
    document.projects = document.projects.filter((project) => !removed.has(project.id));
    document.connections = document.connections.filter((edge) =>
      !removed.has(edge.from) && !removed.has(edge.to),
    );
    await this._save(document);
  }

  remove(id: string) {
    return this.mutate(async () => {
      const state = await this.catalog();
      const entry = state.workspaces.find((entry) => entry.id === id);
      if (!entry) {
        throw new WorkspaceError('Workspace not found.', 404);
      }
      await this._writeState({
        version: 1,
        workspaces: state.workspaces.filter((entry) => entry.id !== id),
      });
      await unlink(join(this.home, 'workspaces', entry.fileName));
    });
  }

  project(document: WorkspaceDocument, id: string) {
    const project = document.projects.find((project) => project.id === id);
    if (!project) {
      throw new WorkspaceError('Project not found.', 404);
    }
    return project;
  }

  mutate<T>(action: () => Promise<T>): Promise<T> {
    const result = this._writes.then(action);
    this._writes = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private constructor(home: string) {
    this.home = home;
  }

  private _writes: Promise<void> = Promise.resolve();

  private async _applyProjectUpdate(
    document: WorkspaceDocument,
    projectId: string,
    input: UpdateProjectInput,
  ) {
    const project = this.project(document, projectId);
    if (
      typeof input.name !== 'string'
      || !input.name.trim()
      || typeof input.settled !== 'boolean'
      || !input.binding
      || !Object.values(GitRevisionKind).includes(input.binding.kind)
      || typeof input.binding.revision !== 'string'
      || !input.binding.revision.trim()
      || !Array.isArray(input.dependencyIds)
      || input.dependencyIds.some((value) => typeof value !== 'string')
      || (input.baseline !== undefined && !isBaseline(input.baseline))
    ) {
      throw new WorkspaceError('Invalid project configuration.');
    }
    const locked = document.connections.filter(
      (edge) => edge.from === projectId && edge.kind === WorkspaceConnectionKind.submodule,
    );
    if (locked.some((edge) => !input.dependencyIds.includes(edge.to))) {
      throw new WorkspaceError('Submodule connections cannot be disconnected.', 409);
    }
    const baseline = input.baseline && { ...input.baseline };
    if (baseline && baseline.commit !== project.baseline?.commit) {
      baseline.commit = await readCommitSha(project.worktreePath, baseline.commit);
    }
    if (baseline?.ref !== undefined && baseline.ref !== project.baseline?.ref) {
      await checkReferenceName(project.worktreePath, baseline.ref);
    }
    const binding = { ...input.binding, revision: input.binding.revision.trim() };
    if (
      binding.kind === GitRevisionKind.commit
      && !/^[a-f0-9]{4,64}$/i.test(binding.revision)
    ) {
      throw new WorkspaceError('请输入 4–64 位十六进制 commit hash。');
    }
    if (binding.kind !== project.binding.kind || binding.revision !== project.binding.revision) {
      if (binding.kind === GitRevisionKind.commit) {
        binding.revision = await readCommitSha(project.worktreePath, binding.revision);
      } else {
        const tag = binding.kind === GitRevisionKind.tag;
        if (tag !== binding.revision.startsWith('refs/tags/')) {
          throw new WorkspaceError('引用类型与选择的分支或标签不一致。');
        }
        if (!await readReferenceCommit(project.worktreePath, binding.revision)) {
          throw new WorkspaceError('所选引用不存在，请重新选择。');
        }
      }
    }
    Object.assign(project, {
      name: input.name.trim(),
      settled: input.settled,
      baseline,
      binding,
    });
    document.connections = document.connections
      .filter((edge) => edge.from !== projectId)
      .concat(
        locked,
        [...new Set(input.dependencyIds)]
          .filter((to) => !locked.some((edge) => edge.to === to))
          .map((to) => ({ from: projectId, to, kind: WorkspaceConnectionKind.manual })),
      );
    validateGraph(document);
    await this._save(document);
    return document;
  }

  private _projectByPath(document: WorkspaceDocument, path: string) {
    const project = document.projects.find(
      (project) =>
        project.worktreePath.toLowerCase()
        === path.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase(),
    );
    if (!project) {
      throw new WorkspaceError(`Worktree is not in this workspace: ${path}`);
    }
    return project;
  }

  private async _addWorktree(
    document: WorkspaceDocument,
    path: string,
    submoduleSha?: string,
  ): Promise<WorkspaceProject> {
    const initialized = await hasWorktree(path);
    if (!initialized && !submoduleSha) {
      throw new WorkspaceError(`Not an initialized worktree: ${path}`);
    }
    const info = initialized ? await inspectWorktree(path) : undefined;
    const canonical = info?.path ?? path.replaceAll('\\', '/');
    const existing = document.projects.find(
      (project) => project.worktreePath.toLowerCase() === canonical.toLowerCase(),
    );
    if (existing) {
      return existing;
    }
    const head = info?.head ?? submoduleSha;
    const project: WorkspaceProject = {
      id: randomUUID(),
      name: basename(canonical),
      worktreePath: canonical,
      baseline: head
        ? {
          commit: head,
          ref: info?.branch ? `refs/heads/${info.branch}` : undefined,
        }
        : undefined,
      settled: false,
      enabled: true,
      binding: info?.branch
        ? { kind: GitRevisionKind.branch, revision: `refs/heads/${info.branch}` }
        : { kind: GitRevisionKind.commit, revision: head ?? '' },
    };
    document.projects.push(project);
    for (const submodule of info?.submodules ?? []) {
      const child = await this._addWorktree(
        document,
        join(canonical, submodule.path),
        submodule.sha,
      );
      document.connections.push({
        from: project.id,
        to: child.id,
        kind: WorkspaceConnectionKind.submodule,
      });
    }
    return project;
  }

  private async _save(document: WorkspaceDocument) {
    document.updatedAt = new Date().toISOString();
    const fileName = `${document.id}.glink-workspace.yaml`;
    await this._writeYaml(join(this.home, 'workspaces', fileName), document);
    const catalog = await this.catalog();
    const summary = {
      id: document.id,
      name: document.name,
      fileName,
      projectCount: document.projects.length,
      updatedAt: document.updatedAt,
    };
    await this._writeState({
      version: 1,
      workspaces: [...catalog.workspaces.filter((entry) => entry.id !== document.id), summary],
    });
  }

  private _writeState(state: GlinkState) {
    return this._writeYaml(join(this.home, 'state.yaml'), state);
  }

  private async _writeYaml(path: string, value: unknown) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, stringify(value), { flag: 'wx' });
    await rename(temporary, path);
  }
}
