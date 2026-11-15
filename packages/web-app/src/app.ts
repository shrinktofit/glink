import { createApp, shallowRef, type App as VueApp } from 'vue';
import type { Router } from 'vue-router';
import type { GlinkCatalog } from '@glink/protocol/workspace';
import { createVuetify } from 'vuetify';
import 'vuetify/styles';
import GlinkApp from './glink-app.vue';
import { GitService } from './git/git-service';
import { GitRepoService, gitRepoServiceKey } from './git/git-repo-service';
import './styles.less';
import './workspace/workspace-theme.less';
import { appKey } from './app-context';
import { createGlinkRouter } from './router';
import { WorkspaceService } from './workspace/workspace-service';

export class App {
  static async create() {
    const app = new App(await WorkspaceService.catalog());
    await app.router.isReady();
    app.vueApp.mount('#root');
    return app;
  }

  readonly catalog = shallowRef<GlinkCatalog>();
  readonly router: Router;
  readonly workspaceService: WorkspaceService;
  readonly vueApp: VueApp;
  readonly gitService: GitService;
  readonly gitRepoService: GitRepoService;

  async refreshCatalog(signal?: AbortSignal) {
    const catalog = await this.workspaceService.catalog(signal);
    if (!signal?.aborted) {
      this.catalog.value = catalog;
    }
  }

  private constructor(catalog: GlinkCatalog) {
    this.catalog.value = catalog;
    this.workspaceService = new WorkspaceService(catalog.home);
    this.gitService = new GitService();
    this.gitRepoService = new GitRepoService(
      this.gitService,
      'U:\\Repos\\codex-worktrees\\helix-next\\vortex',
    );
    this.router = createGlinkRouter(this.gitRepoService.repoPath);
    this.vueApp = createApp(GlinkApp);
    this.vueApp.use(createVuetify({ theme: { defaultTheme: 'light' } }));
    this.vueApp.use(this.router);
    this.vueApp.provide(gitRepoServiceKey, this.gitRepoService);
    this.vueApp.provide(appKey, this);
  }
}
