package web

import "embed"

// Assets 内嵌全部离线前端页面与脚本，实现零外部 CDN 依赖。
//
//go:embed all:assets css js index.html favicon.svg
var Assets embed.FS
