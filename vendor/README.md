# 第三方源码维护

Cordis 4.1.0 和 Cosmokit 1.9.0 源自 `deepseek-ai/deepseek-harness` 的 `39163dd30f`，原作者及许可证见各目录的 `LICENSE`。A.ai 使用本仓库内的源码构建。Cordis 的内部 Cosmokit 导入改为本地工作区名称，A.ai 的入口通过私有名称 `@A-ai/cordis` 导入。

同步上游时，先对比固定的 Git 提交及版权文件，核对本地命名改动，再运行 Cordis 装配、事件和释放测试。更新此处的提交号与改动说明后，再生成生产构建。
