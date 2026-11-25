# SpaceMap v2.0 - NAS 存储空间可视化分析器

SpaceMap 是一款参考群晖存储空间分析器设计的轻量级 NAS 空间分析工具，采用 **Go 单二进制 + SQLite + 纯离线前端** 架构，原生支持 **飞牛 fnOS (`.fpk`)**、**威联通 QNAP (`.qpkg`)** 与 **Docker** 部署，同时兼容 `x86_64` 与 `ARM64` 架构。

## 核心特性

- **100% 离线单文件运行**：前端（含 ECharts）通过 `embed.FS` 内嵌进二进制，纯内网 NAS 零外网依赖。
- **硬链接真实空间去重**：基于 `(dev, ino)` 识别 PT 保种、影音硬链接文件，分别展示实际物理占用与逻辑大小。
- **多维度空间分析**：
  - **空间总览**：Treemap 矩形树图 / 横向条形图切换、按占用空间（可切按数量）的文件类型环形图、历史增长曲线。
  - **目录分析**：面包屑路径下钻，精准展示子文件夹与直接文件。
  - **大文件排行**：关键词搜索、类型与体积筛选、排序分页与 CSV/JSON 报告导出。
  - **精确重复文件清理**：大小预筛 -> 首尾 64KB 指纹 -> 全量 SHA-256 校验，支持“保留最新 / 保留最旧”快捷勾选。
  - **冷数据清理**：快速筛出 90 天 / 180 天 / 1 年 / 2 年未修改的沉睡大文件。
- **SSE 实时进度 & 后台定时任务**：实时展示当前扫描目录与文件数，支持随时取消及每天/每周/固定间隔自动扫描。
- **安全保护**：默认感知挂载只读状态（`:ro` 时自动禁用删除）、批量删除二次确认清单弹窗、SQLite 持久化密码登录会话。

---

## 一键打包飞牛 `.fpk`、威联通 `.qpkg` 与双架构二进制

在 Linux/macOS 环境下执行（需要 Go 1.25+ 与 `tar`）：

```bash
chmod +x scripts/build-all.sh
./scripts/build-all.sh
```

打包产物位于 `dist/` 目录：
- **飞牛 fnOS**：`dist/spacemap_2.0.0_x86.fpk`、`dist/spacemap_2.0.0_arm64.fpk`
- **威联通 QNAP**：`dist/SpaceMap_2.0.0_x86_64.qpkg`、`dist/SpaceMap_2.0.0_arm_64.qpkg`
- **裸二进制**：`dist/bin/spacemap-linux-amd64`、`dist/bin/spacemap-linux-arm64`

### 飞牛 fnOS 安装方式
1. 打开飞牛【应用中心】 -> 右上角【设置】 -> 【手动安装应用】，上传对应架构的 `.fpk`。
2. 在应用详情的「文件夹授权」中勾选要分析的共享目录（系统会通过 `TRIM_DATA_SHARE_PATHS` 自动传入，免手工映射）。
3. 默认 Web 端口为 `7080`，可通过飞牛桌面图标直接打开。

### 威联通 QNAP 安装方式
1. 打开威联通【App Center】 -> 右上角【手动安装】，上传对应架构的 `.qpkg`。
2. 套件自动识别 `/share` 下的有效共享文件夹（自动过滤系统卷与循环挂载），安装后即可在桌面打开（端口 `7080`）。

---

## Docker 部署

```yaml
services:
  spacemap:
    image: zhong12138/spacemap:latest
    container_name: spacemap
    restart: unless-stopped
    ports:
      - "7080:7080"
    volumes:
      - ./data:/app/data
      - /your/nas/media:/media:ro
    environment:
      - PORT=7080
      - DATA_DIR=/app/data
      - TRIM_DATA_SHARE_PATHS=/media
```

运行：

```bash
docker compose up -d
```

访问 `http://<NAS_IP>:7080`。如需允许在网页端直接删除文件，请将挂载卷去掉 `:ro` 改为读写挂载。
