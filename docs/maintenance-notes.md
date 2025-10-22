droid.raw.js 是最新版本的原始 dump，对应路径 `artifacts/droid.raw.js`

droid.js 是应用规则后的最终版本，对应路径 `artifacts/droid.js`

droid.old.js 保留上一版的处理结果，对应路径 `artifacts/droid.old.js`

`scripts/update-from-factory.ts` 负责完整的下载、dump、规则应用与格式化流程，默认会把产物写入 `artifacts/` 目录。更新流程如下：

1. 执行 `bun scripts/update-from-factory.ts`；
2. 脚本会请求 `https://app.factory.ai/cli/windows` 获取最新版本号，并生成下载地址；
3. 若 `artifacts/droid.version.json` 的版本号与最新版本相同，将直接跳过下载（可使用 `--force` 强制更新）；
4. 下载完成后会调用 `scripts/extract-standalone.ts` 解包 exe，生成 `droid.exe`、`keytar-*.node` 和 `metadata.json`；
5. 脚本会自动完成旧版本备份、生成 `droid.raw.js`、尝试运行 ast-grep 规则、格式化、最后输出新的 `droid.js`。

`artifacts/droid.version.json` 记录最近一次更新的版本号、架构和下载地址，用于避免重复下载；该文件没有纳入 Git 追踪，仅用作本地缓存。

如需手工操作，可参考下述备用流程：

1. 使用 `bun scripts/extract-standalone.ts <droid.exe 路径> artifacts` 解包；
2. 将 `artifacts/droid.js` 备份为 `artifacts/droid.old.js`，再把最新 dump 重命名为 `artifacts/droid.js`；
3. `cp artifacts/droid.js artifacts/droid.raw.js` 保留原始版本；
4. （可选）运行 `bun scripts/apply-rules.ts` 生成 `artifacts/droid.generated.js` 并人工对比；
5. 使用 `biome format --write <文件路径>` 进行格式化。

ast-grep 的规则配置位于 `rules/`，公共配置写在 `sgconfig.yml`。如需回顾 ast-grep 的语法，可查看线上文档并在此文件补充关键信息，避免遗忘。

创建该项目的目的是 优化droid.js 但很明显每次更新 minify都会导致js代码变化 名称映射发生改变 所以没有很好的正则方式进行优化 所以决定使用ast-grep来作为编辑工具

优化目标
- (droid测试通过,ast-grep已实现) 默认开启DROID_SKIP_CA_BOOTSTRAP 禁用导入CA证书
- (droid测试通过,ast-grep已实现) GREP工具优先使用系统rg 而不是~/.factory/bin/rg.exe
- (droid测试通过,ast-grep未实现) 自定义模型若支持reasoningEffort也能在设置里调节，对应解析`supported_reasoning_efforts`与`default_reasoning_effort`

## 多版本兼容性测试

为确保ast-grep规则在不同版本间的兼容性，需要进行完整的测试流程：

1. **测试当前版本**：
   - 执行 `bun .\droid.js --version` 确认当前版本功能正常
   - 执行 `bun .\droid.generated.js --version` 确认修改后的版本功能正常

2. **测试历史版本兼容性**：
   - 执行 `bun .\droid.old.js --version` 确认历史版本功能正常
   - 使用相同ast-grep规则在droid.old.js上进行测试，确保规则对旧版本同样有效

3. **验证流程**：
   - 每次修改规则后，必须同时在新版本和旧版本上进行测试
   - 如果任一版本测试失败，需要调整规则以保证向后兼容性
   - 记录测试结果，确保优化不会破坏已有功能

计划
- 在`droid.js`中定位涉及`DROID_SKIP_CA_BOOTSTRAP`和`rg`调用的逻辑，梳理不同版本间可能出现的结构差异。
- 根据差异整理可复用的ast-grep查询与替换方案，确保对多个版本具有兼容性。
- 已基于片段验证ast-grep规则，并通过`scripts/apply-rules.ts`脚本在`droid.raw.js`上运行确保生成结果与`droid.js`一致。
- 使用`bun scripts/apply-rules.ts`可以自动生成`artifacts/droid.generated.js`，与`artifacts/droid.js` diff 即可确认是否仍需手动更新。
- 修改完成后运行`bun .\droid.js --version`等自检流程，确认功能正常。

Ast-grep 自动化说明
- 根目录新增`sgconfig.yml`和两条规则（`rules/enable-skip-ca-bootstrap.yml`、`rules/prefer-system-rg.yml`），对应证书逻辑和ripgrep解析的改写。
- `sg scan`在超大文件上会被 size 限制跳过，改为使用`scripts/apply-rules.ts`提取目标函数、对片段运行ast-grep并回填，避免直接扫8MB文件。
- 执行步骤：
  1. 确保`droid.raw.js`为最新dump；
  2. 运行`bun scripts/apply-rules.ts`，脚本会在`droid.generated.js`输出改写结果；
  3. 比对`droid.generated.js`与`droid.js`，确认需要的改动是否已经包含；如有差异再手动合并。
- 若要进一步扩展规则，可在`rules/`目录新增yaml并复用脚本流程。
