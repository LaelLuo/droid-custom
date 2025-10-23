# droid-custom

## 项目简介
- 解析 `bun build --compile` 产物以提取出 `droid.js` 等模块，便于在源码层面进行定制化修改。
- 依赖 ast-grep 自动化重写部分逻辑，覆盖证书引导、ripgrep 路径选择、自定义模型 reasoning 配置等优化项。

## 环境依赖
- Bun ≥ 1.0：执行下载、解包与测试脚本
- Biome CLI：格式化 `droid.js` 等生成文件
- ast-grep CLI：支撑 `scripts/apply-rules.ts` 进行语法级替换
- curl（可选）：手动调试下载时可复用

## 目录结构
- `artifacts/`：存放从官方发布包解包得到的二进制与 js 产物（Git 仅跟踪 `.gitkeep`）
- `docs/`：维护笔记与更新流程说明，`maintenance-notes.md` 汇总人工/自动化细节
- `rules/`：ast-grep 规则集合，配合 `sgconfig.yml` 使用
- `scripts/`：所有 Bun 脚本；包含解包、规则应用与下载更新的自动化逻辑
- `biome.json`：Biome 格式化配置；`sgconfig.yml`：ast-grep 配置入口

## 常用命令
- `bun run update`：执行 `scripts/update-from-factory.ts`，自动下载最新版 droid、完成解包、应用规则与格式化
- `bun run apply-rules`：独立运行 ast-grep 规则，生成 `artifacts/droid.generated.js`
- `bun run extract <exe> [输出目录]`：调用 `scripts/extract-standalone.ts` 解包任意 Bun 可执行文件

## 自动更新流程
1. 运行 `bun run update`
2. 脚本解析安装脚本获取最新版本 → 下载 → 校验 SHA256 → 解包 → 备份旧版
3. 若 ast-grep 规则成功，自动覆盖 `artifacts/droid.js`；失败时保留 `droid.raw.js` 供人工排查
4. 版本信息写入 `artifacts/droid.version.json`，避免重复下载（可加 `--force` 强制更新）

## 开发提示
- 修改规则后建议运行 `bun run apply-rules` 并对比 `artifacts/droid.generated.js` 与 `artifacts/droid.js`
- 若需要测试，可在 `tests/` 下补充 Bun 测试用例，然后执行 `bun test`
- 在提交前请运行 Biome 格式化及相关脚本，确保生成文件符合预期

## 绕过登陆
创建`~/.factory/auth.json`，内容如下
```json
{
  "access_token": "eyJhbGciOiJub25lIn0.eyJzdWIiOiAib2ZmbGluZS11c2VyIiwgImVtYWlsIjogIm9mZmxpbmVAbG9jYWwiLCAiZXh0ZXJuYWxfb3JnX2lkIjogIm9mZmxpbmUtb3JnIiwgImV4cCI6IDQxMDI0NDQ4MDB9."
}
```
