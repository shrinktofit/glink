import { createApp, type App as VueApp } from 'vue';
import { createVuetify } from 'vuetify';
import 'vuetify/styles';
import GlinkApp from './glink-app.vue';
import { GitService } from './git/git-service';
import { GitRepoService, gitRepoServiceKey } from './git/git-repo-service';
import './styles.less';

export class App {
  constructor() {
    this.gitService = new GitService();
    this.gitRepoService = new GitRepoService(
      this.gitService, 'U:\\Repos\\codex-worktrees\\helix-next\\vortex',
    );
    this.vueApp = createApp(GlinkApp);
    this.vueApp.use(createVuetify({ theme: { defaultTheme: 'light' } }));
    this.vueApp.provide(gitRepoServiceKey, this.gitRepoService);
    this.vueApp.mount('#root');
  }

  readonly vueApp: VueApp;
  readonly gitService: GitService;
  readonly gitRepoService: GitRepoService;
}
