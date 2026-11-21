// @vitest-environment happy-dom
import { createPinia } from 'pinia';
import { nextTick, ref, shallowRef } from 'vue';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitDiffType, GitRevisionKind } from '@glink/protocol/git';
import type {
  GlinkCatalog,
  WorkspaceCommit,
  WorkspaceDocument,
  WorkspaceProjectStatus,
} from '@glink/protocol/workspace';
import { appKey } from '../src/app-context';
import WorkspaceRouteView from '../src/components/workspace/workspace-route-view.vue';
import WorkspacePage from '../src/components/workspace/workspace-page.vue';
import WorkspaceOutline from '../src/components/workspace/workspace-outline.vue';
import WorkspaceChangeList from '../src/components/workspace/workspace-change-list.vue';
import WorkspaceHistory from '../src/components/workspace/workspace-history.vue';

enableAutoUnmount(afterEach);

const change = { path: 'file.txt', type: GitDiffType.modified };

function openWorkspace() {
  const document: WorkspaceDocument = {
    version: 3,
    id: 'workspace',
    name: 'Workspace',
    createdAt: '2026-11-21T00:00:00Z',
    updatedAt: '2026-11-21T00:00:00Z',
    projects: ['alpha', 'beta', 'gamma'].map((id) => ({
      id,
      name: id,
      worktreePath: `C:/temporary/${id}`,
      enabled: true,
      settled: false,
      binding: { kind: GitRevisionKind.branch, revision: 'main' },
    })),
    connections: [],
  };
  const documents = new Map([[document.id, document]]);
  const commits: WorkspaceCommit[] = document.projects.map((project) => ({
    projectId: project.id,
    sha: `${project.id}-commit`,
    subject: `${project.name} change`,
    author: 'Test',
    authoredAt: '2026-11-21T00:00:00Z',
    parents: [],
  }));
  const service = {
    get: vi.fn((id: string) => Promise.resolve(structuredClone(documents.get(id)!))),
    status: vi.fn((id: string): Promise<WorkspaceProjectStatus[]> =>
      Promise.resolve(documents.get(id)!.projects.map((project) => ({
        projectId: project.id,
        staged: [],
        unstaged: [change],
        indexFingerprint: `${project.id}-index`,
        head: `${project.id}-head`,
      })))),
    history: vi.fn((_id: string, ids: readonly string[]) => Promise.resolve({
      commits: commits.filter((commit) => ids.includes(commit.projectId)),
      errors: [],
    })),
    diff: vi.fn().mockResolvedValue({ original: 'before', modified: 'after' }),
  };
  const app = {
    deletionVersion: ref(0),
    workspaceService: service,
    catalog: shallowRef<GlinkCatalog>(),
    refreshCatalog: vi.fn(() => {
      app.catalog.value = {
        version: 1,
        home: 'C:/temporary/home',
        workspaces: [...documents.values()].map((entry) => ({
          id: entry.id,
          name: entry.name,
          fileName: `${entry.id}.glink-workspace.yaml`,
          projectCount: entry.projects.length,
          updatedAt: entry.updatedAt,
        })),
      };
      return Promise.resolve();
    }),
    gitService: {},
  };
  const wrapper = mount(WorkspaceRouteView, {
    props: { name: document.name },
    global: {
      plugins: [createPinia()],
      provide: { [appKey as symbol]: app },
      stubs: {
        RouterLink: true,
        GitFileDiff: {
          props: ['path', 'diff', 'error'],
          template: '<section data-diff><div data-reader>{{ path }}</div></section>',
        },
        WorkspaceCommitDetail: true,
        WorkspaceProjectGraph: true,
        VTooltip: { inheritAttrs: false, template: '<slot name="activator" :props="{}" />' },
        VMenu: true,
        VList: true,
        VListItem: true,
      },
    },
  });
  return {
    app,
    service,
    document,
    documents,
    wrapper,
  };
}

describe('Workspace state after worktree deletion', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('keeps the page and reading context while deletion data refreshes', async () => {
    /// @case The user reads beta while an unrelated alpha worktree is deleted.
    /// @expect Refresh data in place, preserving the mounted page and beta reading context.
    const {
      app,
      service,
      documents,
      document,
      wrapper,
    } = openWorkspace();
    await flushPromises();
    wrapper.getComponent(WorkspaceOutline).vm.$emit('select', 'beta', new MouseEvent('click'));
    await nextTick();
    wrapper.findAllComponents(WorkspaceChangeList)[0].vm.$emit('select', 'beta', change);
    await flushPromises();
    await wrapper.get('input[aria-label="Workspace commit message"]').setValue('Draft message');
    await wrapper.get('[aria-label="展开关系图"]').trigger('click');
    await wrapper.get('.workspace-content > [role="separator"]')
      .trigger('keydown', { key: 'ArrowRight' });
    const page = wrapper.getComponent(WorkspacePage).element;
    const reader = wrapper.get('[data-reader]').element;
    reader.scrollTop = 123;
    const updated = { ...document, projects: document.projects.slice(1) };
    documents.set(document.id, updated);
    let finish!: (value: WorkspaceDocument) => void;
    service.get.mockImplementationOnce(() => new Promise<WorkspaceDocument>((fulfill) => {
      finish = fulfill;
    }));
    app.deletionVersion.value++;
    try {
      await flushPromises();
      expect(wrapper.getComponent(WorkspacePage).element).toBe(page);
      expect(wrapper.get('[data-reader]').element).toBe(reader);
    } finally {
      finish(updated);
      await flushPromises();
    }
    expect(wrapper.getComponent(WorkspacePage).element).toBe(page);
    expect(wrapper.getComponent(WorkspaceOutline).props('selected')).toEqual(['beta']);
    expect(wrapper.get('[data-reader]').element).toBe(reader);
    expect(reader.scrollTop).toBe(123);
    expect(wrapper.get<HTMLInputElement>('input[aria-label="Workspace commit message"]')
      .element.value).toBe('Draft message');
    expect(wrapper.find('.graph-drawer').exists()).toBe(true);
    expect(wrapper.get('.workspace-content > [role="separator"]').attributes('aria-valuenow'))
      .toBe('34');
    expect(wrapper.getComponent(WorkspaceOutline).props('workspace').projects
      .map((project: { id: string }) => project.id)).toEqual(['beta', 'gamma']);
  });

  it('drops a deleted project selection and diff without clearing the commit draft', async () => {
    /// @case The selected beta project and its open diff are deleted.
    /// @expect Discard beta state, select a remaining project, and retain the page's commit draft.
    const {
      app,
      documents,
      document,
      wrapper,
    } = openWorkspace();
    await flushPromises();
    wrapper.getComponent(WorkspaceOutline).vm.$emit('select', 'beta', new MouseEvent('click'));
    await nextTick();
    wrapper.findAllComponents(WorkspaceChangeList)[0].vm.$emit('select', 'beta', change);
    await flushPromises();
    await wrapper.get('input[aria-label="Workspace commit message"]').setValue('Keep this draft');
    documents.set(document.id, {
      ...document,
      projects: document.projects.filter((project) => project.id !== 'beta'),
    });
    app.deletionVersion.value++;
    await flushPromises();
    expect(wrapper.find('[data-diff]').exists()).toBe(false);
    expect(wrapper.getComponent(WorkspaceOutline).props('selected')).toEqual(['alpha']);
    expect(wrapper.getComponent(WorkspaceOutline).props('statuses')
      .map((status: WorkspaceProjectStatus) => status.projectId)).toEqual(['alpha', 'gamma']);
    expect(wrapper.get<HTMLInputElement>('input[aria-label="Workspace commit message"]')
      .element.value).toBe('Keep this draft');
  });

  it('keeps the history tab and selected surviving commit after deletion', async () => {
    /// @case The user reads a beta commit while alpha is deleted.
    /// @expect Keep the history view and its selection, scroll position and commit detail instance.
    const {
      app,
      documents,
      document,
      wrapper,
    } = openWorkspace();
    await flushPromises();
    wrapper.getComponent(WorkspaceOutline).vm.$emit('select', 'beta', new MouseEvent('click'));
    await flushPromises();
    await wrapper.findAll('.mainbar > button')[1].trigger('click');
    const history = wrapper.getComponent(WorkspaceHistory);
    const detail = wrapper.get('workspace-commit-detail-stub').element;
    history.element.scrollTop = 87;
    documents.set(document.id, { ...document, projects: document.projects.slice(1) });
    app.deletionVersion.value++;
    await flushPromises();
    expect(wrapper.getComponent(WorkspaceHistory).element).toBe(history.element);
    expect(wrapper.getComponent(WorkspaceHistory).props('modelValue')?.sha).toBe('beta-commit');
    expect(history.element.scrollTop).toBe(87);
    expect(wrapper.get('workspace-commit-detail-stub').element).toBe(detail);
    expect(wrapper.findAll('.mainbar > button')[1].classes()).toContain('active');
  });

  it('keeps the page and draft when data refresh fails', async () => {
    /// @case The server cannot reload workspace data after deletion.
    /// @expect Keep the existing page and draft, with a visible error and refresh control.
    const { app, service, wrapper } = openWorkspace();
    await flushPromises();
    const page = wrapper.getComponent(WorkspacePage).element;
    await wrapper.get('input[aria-label="Workspace commit message"]').setValue('Unsaved');
    service.get.mockRejectedValueOnce(new Error('Workspace refresh unavailable.'));
    app.deletionVersion.value++;
    await flushPromises();
    expect(wrapper.getComponent(WorkspacePage).element).toBe(page);
    expect(wrapper.get('[role="alert"]').text()).toContain('Workspace refresh unavailable.');
    expect(wrapper.get<HTMLInputElement>('input[aria-label="Workspace commit message"]')
      .element.value).toBe('Unsaved');
    expect(wrapper.get('[aria-label="刷新工作区"]').isVisible()).toBe(true);
  });

  it('keeps surviving multi-selected projects and their open diff', async () => {
    /// @case Beta and gamma are selected, gamma is being read, then beta is deleted.
    /// @expect Keep gamma selected and preserve its diff
    /// rather than selecting an unrelated project.
    const {
      app,
      documents,
      document,
      wrapper,
    } = openWorkspace();
    await flushPromises();
    const projects = wrapper.findAll('.project-pick');
    await projects[1].trigger('click');
    await projects[2].trigger('click', { ctrlKey: true });
    await wrapper.get('#changes-false-gamma [role="treeitem"]').trigger('click');
    await flushPromises();
    const reader = wrapper.get('[data-reader]').element;
    documents.set(document.id, {
      ...document,
      projects: document.projects.filter((project) => project.id !== 'beta'),
    });
    app.deletionVersion.value++;
    await flushPromises();
    expect(wrapper.getComponent(WorkspaceOutline).props('selected')).toEqual(['gamma']);
    expect(wrapper.get('[data-reader]').element).toBe(reader);
    expect(wrapper.get('[aria-label="Workspace unstaged"] [role="treeitem"]')
      .attributes('aria-selected')).toBe('true');
  });

  it('keeps workspace navigation separate from a pending deletion refresh', async () => {
    /// @case The user changes workspace while the old workspace's deletion refresh is pending.
    /// @expect Open the new workspace with its own state; late data must not replace it.
    const {
      app,
      service,
      documents,
      document,
      wrapper,
    } = openWorkspace();
    await flushPromises();
    await wrapper.get('input[aria-label="Workspace commit message"]').setValue('Old draft');
    const other: WorkspaceDocument = { ...document, id: 'other', name: 'Other workspace' };
    documents.set(other.id, other);
    let finish!: (value: WorkspaceDocument) => void;
    service.get.mockImplementationOnce(() => new Promise<WorkspaceDocument>((fulfill) => {
      finish = fulfill;
    }));
    app.deletionVersion.value++;
    await flushPromises();
    try {
      await wrapper.setProps({ name: other.name });
      await flushPromises();
      expect(wrapper.getComponent(WorkspaceOutline).props('workspace').id).toBe(other.id);
      expect(wrapper.get<HTMLInputElement>('input[aria-label="Workspace commit message"]')
        .element.value).toBe('');
    } finally {
      finish(document);
      await flushPromises();
    }
    expect(wrapper.getComponent(WorkspaceOutline).props('workspace').id).toBe(other.id);
  });
});
