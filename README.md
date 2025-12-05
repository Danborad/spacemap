# SpaceMap Docker 版本

这是 SpaceMap 存储空间分析器的 Docker 版本。

## 目录结构
- `app/`: 源代码目录
- `data/`: 数据持久化目录 (运行后生成)
- `Dockerfile`: 镜像构建文件
- `docker-compose.yml`: 容器编排文件

## 快速开始

### 1. 构建并启动
确保已安装 Docker 和 Docker Compose。

你可以直接使用以下的 `docker-compose.yml` 模板：

```yaml
version: '3'

services:
  spacemap:
    # 使用官方镜像（请替换 username 为你的 Docker Hub 用户名）
    image: username/spacemap:latest
    container_name: spacemap
    restart: unless-stopped
    ports:
      - "7080:7080"
    volumes:
      - ./data:/app/data
      # 示例：映射宿主机目录到容器内，并设置为只读
      - /your/host/media:/media:ro
    environment:
      - PORT=7080
      # 设置自动识别的扫描路径，多个路径用冒号 : 分隔
      # 这里的路径必须与 volumes 中映射的容器内路径一致
      - TRIM_DATA_SHARE_PATHS=/media
```

将上述内容保存为 `docker-compose.yml`，然后运行：

```bash
docker-compose up -d
```

### 2. 访问应用
打开浏览器访问：[http://localhost:7080](http://localhost:7080)

### 3. 扫描宿主机目录（自动识别）
可以通过 Docker 挂载卷（Volumes）和环境变量（Environment Variables）来实现自动识别和扫描宿主机目录。

修改 `docker-compose.yml`：

```yaml
volumes:
  - ./data:/app/data
  # 格式：- 宿主机路径:容器内路径:权限
  - /vol1/host/电影:/电影:ro
  - /vol1/host/音乐:/音乐:ro

environment:
  - PORT=7080
  # 告诉应用哪些路径是可用的，用冒号分隔
  - TRIM_DATA_SHARE_PATHS=/电影:/音乐
```

这样设置后，应用启动时会自动将 `/电影` 和 `/音乐` 识别为可用扫描路径，无需在设置中手动添加。

## 停止服务
```bash
docker-compose down
```
