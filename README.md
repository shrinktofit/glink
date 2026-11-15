# Glink

连接仓库，协同版本。

Glink 是一个基于 Web 的本地 Git 工作台，把一起开发的多个仓库和 worktree 组织成一个工作区。

- **工作区**：创建、打开和管理工作区，自动识别递归 submodule，也可以手动连接项目依赖。
- **项目状态**：集中查看各项目的修改与完成状态，设置分支关联和 base commit。
- **修改与提交**：按项目汇总 staged / unstaged 文件，查看双栏 Diff，逐文件暂存，按依赖顺序提交选定项目。
- **聚焦历史**：查看各项目从 base commit 到 HEAD 的提交及文件变化。
- **仓库浏览**：浏览提交图、worktree、分支、远端、标签、stash 和 submodule，支持 Commit 与 Amend。

工作区配置保存在本地 YAML 文件中。
