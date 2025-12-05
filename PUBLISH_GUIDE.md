# 发布到 GitHub 和 Docker Hub 指南

本指南将帮助你将 SpaceMap 项目发布到 GitHub，并配置自动构建发布到 Docker Hub。

## 第一步：准备 GitHub 仓库

1.  **初始化 Git 仓库**（已完成）：
    本项目 `docker` 目录已初始化为独立的 Git 仓库。
    请确保在 `g:\1qoder\cursor\spacemap\fpk开发\docker` 目录下执行后续命令。

2.  **创建 GitHub 仓库**：
    - 登录 GitHub，创建一个新仓库（例如命名为 `spacemap-docker`）。
    - 按照 GitHub 页面提示，将本地代码推送到远程仓库：
      ```bash
      # 确保你在 docker 目录下
      git branch -M main
      git remote add origin https://github.com/你的用户名/spacemap-docker.git
      git push -u origin main
      ```

## 第二步：准备 Docker Hub

1.  **注册/登录 Docker Hub**：
    访问 [hub.docker.com](https://hub.docker.com/) 并登录。

2.  **创建仓库**：
    点击 "Create Repository"，输入名称 `spacemap`，可见性选择 Public（公开）或 Private（私有）。

3.  **获取访问令牌 (Token)**：
    - 点击右上角头像 -> **Account Settings** -> **Security**。
    - 点击 **New Access Token**。
    - Description 填 "GitHub Actions"，Access permissions 选 "Read, Write, Delete"。
    - **复制生成的 Token**（只显示一次，请保存好）。

## 第三步：配置 GitHub Actions 自动化

我已经为你创建了自动化配置文件 `.github/workflows/docker-publish.yml`。你需要配置 Secrets 让 GitHub 有权限推送到你的 Docker Hub。

1.  回到你的 GitHub 仓库页面。
2.  点击 **Settings** -> **Secrets and variables** -> **Actions**。
3.  点击 **New repository secret**，添加以下两个密钥：
    - **Name**: `DOCKERHUB_USERNAME`
      - **Value**: 你的 Docker Hub 用户名
    - **Name**: `DOCKERHUB_TOKEN`
      - **Value**: 刚才复制的 Access Token

## 第四步：验证自动发布

完成上述配置后，当你下次推送代码到 GitHub 时，自动构建就会触发：

1.  修改任意文件并提交推送：
    ```bash
    git add .
    git commit -m "Test build"
    git push
    ```
2.  在 GitHub 仓库点击 **Actions** 标签页，你可以看到 "Docker Image CI" 工作流正在运行。
3.  运行成功后，你的 Docker Hub 仓库中就会出现新的镜像 `spacemap:latest`。

## 以后如何更新？

只需要修改代码，然后 `git push` 到 GitHub，GitHub Actions 就会自动帮你构建新的 Docker 镜像并发布到 Docker Hub。
用户可以通过 `docker pull 你的用户名/spacemap:latest` 来下载最新版本。
