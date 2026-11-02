# Str Cat · Hexo + Redefine

博客地址：<https://wawoscarqaq.github.io/>

这个仓库保存可编辑的 Hexo 源代码。`master` 分支发生更新后，GitHub Actions 会安装锁定的依赖、生成网页并发布到 **GitHub Pages**。不需要本地运行网站或手动上传 `public/`。

## 首次启用 GitHub Pages

在仓库 **Settings → Pages → Build and deployment → Source** 中选择 **GitHub Actions**。

工作流文件为 `.github/workflows/pages.yml`，支持推送自动触发和在 Actions 页面手动运行。云端使用 Node.js 22、Hexo 7.3.0 和 Redefine 2.9.0；依赖由 `package-lock.json` 锁定。不需要额外创建访问令牌或部署密钥。

## 写文章和添加封面

在 `source/_posts/` 中添加 Markdown 文件，例如 `my-post.md`：

```markdown
---
title: 我的文章
date: 2026-11-02 20:00:00
tags: [技术笔记]
thumbnail: /images/covers/my-post.jpg
cover: /images/covers/my-post.jpg
excerpt: 这篇文章的简短介绍。
---

这里开始写正文。
```

图片保存到 `source/images/covers/my-post.jpg`。`thumbnail` 用于首页文章卡片，`cover` 用于文章顶部；两者可以分别指定不同图片。也可以使用完整的 HTTPS 图片链接。

新文章脚手架已包含默认封面。使用本地编辑器时可以运行 `npm run new -- "my-post"` 创建文章，但发布始终由 GitHub Pages 完成。也可以直接在 GitHub 网页上添加或编辑文章。

## 修改外观

- `_config.yml`：博客标题、作者、网址、时区和永久链接。
- `_config.redefine.yml`：主题配色、导航、文章样式。当前使用浅色、单栏文章列表，关闭全屏首页横幅、侧栏和未配置的评论服务。
- `source/about/index.md`：关于页面。
- `source/images/avatar.svg`：头像和网站图标。

原有 Hello World 文章及其 `/2025/02/26/hello-world/` 地址已保留。

## 绑定自己的域名

购买域名并按 GitHub Pages 文档配置 DNS，在仓库 Settings → Pages 中设置 Custom domain，然后同时修改 `_config.yml` 的 `url` 和 `_config.redefine.yml` 的 `info.url`。根域名部署时 `root` 保持 `/`。

使用此仓库的 GitHub Actions 直接发布 Pages artifact 时，无需 `CNAME` 文件；域名由 GitHub Pages 设置管理。

## 构建检查

工作流运行 `npm ci`、`npm run build` 和 `npm run verify`。验证会检查主要页面、原文章永久链接、封面图片以及首页和文章页引用的本地资源。样式链接会自动附带当前提交的版本号，避免更新配色后被旧缓存覆盖。

安装依赖后也可以在本地运行构建检查，检查不会启动网站或部署服务：

```bash
npm ci
npm run build
npm run verify
```

## 回退

旧站点的提交历史保留在本仓库，迁移前提交为 `d0809c9a696fe50c3be3f431edb9e26679e86eff`，本地备份分支为 `backup/cards-before-redefine-20261102`。迁移使用普通提交和推送，不覆盖 Git 历史。

## 文档

- [Hexo](https://hexo.io/zh-cn/docs/)
- [Redefine](https://redefine-docs.ohevan.com/zh/docs/getting-started)
- [GitHub Pages](https://docs.github.com/en/pages)
