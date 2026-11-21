// @vitest-environment happy-dom
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appKey } from '../src/app-context';
import { RouteName } from '../src/router';
import GlinkMenu from '../src/components/glink-menu.vue';

enableAutoUnmount(afterEach);

describe('Glink menu window commands', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'glinkWindow');
    vi.restoreAllMocks();
  });

  async function openMenu() {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: RouteName.starter, component: { template: '<div />' } },
        {
          path: '/worktree/:worktreePath',
          name: RouteName.worktree,
          component: { template: '<div />' },
        },
      ],
    });
    await router.push('/');
    const wrapper = mount(GlinkMenu, {
      global: {
        plugins: [router],
        provide: { [appKey as symbol]: { gitRepoService: { repoPath: 'C:/fixture' } } },
      },
    });
    await wrapper.get('[aria-label="Glink menu"]').trigger('click');
    return wrapper;
  }

  it('reloads the browser page from a separate command section', async () => {
    /// @case A regular browser opens Glink's menu without a native window bridge.
    /// @expect Reload closes the menu and reloads the page; native DevTools are not offered.
    const reload = vi.spyOn(window.location, 'reload').mockReturnValue(undefined);
    const wrapper = await openMenu();
    expect(wrapper.find('[role="separator"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('打开开发者工具');
    await wrapper.findAll('[role="menuitem"]')
      .find((item) => item.text() === '重载窗口')!.trigger('click');
    expect(reload).toHaveBeenCalledOnce();
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
  });

  it('opens native developer tools and closes the menu', async () => {
    /// @case An Electron window provides its controlled DevTools bridge.
    /// @expect The menu invokes only that window action and dismisses itself.
    const openDevTools = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'glinkWindow', {
      configurable: true,
      value: { openDevTools },
    });
    const wrapper = await openMenu();
    await wrapper.findAll('[role="menuitem"]')
      .find((item) => item.text() === '打开开发者工具')!.trigger('click');
    expect(openDevTools).toHaveBeenCalledOnce();
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
  });
});
