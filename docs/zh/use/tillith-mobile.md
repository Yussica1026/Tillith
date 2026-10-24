# Tillith 客户端

Tillith 直接使用本仓库的 Python 核心，客户端位于 `mobile/`，采用 React、TypeScript、Vite 和 Capacitor。界面按可用宽度自适应，供手机、平板与桌面使用；平台能力通过原生桥接接入。

## 运行位置

连接设置提供两种模式：

| 模式 | 核心运行位置 | 当前状态 |
| --- | --- | --- |
| 云端核心 | 指定的 Tillith 服务器 | 已通过本机真实核心验证连接、会话、`/help`、附件与历史持久化；本轮没有部署公共云服务。 |
| 手机内置核心 | Android 应用内的 Python 运行时 | 已在桌面环境验证嵌入启动入口、鉴权与身份持久化；Android 原生依赖及 APK 尚未通过运行验证。 |

浏览器不能启动手机内置核心；没有可用原生桥接时，界面会明确显示不可用。`127.0.0.1` 始终指当前设备，本机开发入口不能直接作为另一台手机的服务器地址。

## 本机启动

在仓库根目录运行。当前开发环境使用 `.runtime/core` 中的 Python 3.12 与完整核心依赖，运行数据保存在 `.runtime/local`。先构建客户端，再启动核心：

```powershell
cd mobile
npm.cmd ci
npm.cmd run build
cd ..
.runtime\core\Scripts\python.exe scripts/tillith_dev.py start
```

打开 `http://127.0.0.1:6195`。该入口由真实 Python 核心直接提供 `mobile/dist`，默认只监听本机；Windows 后台进程隐藏运行。启动器关闭指标上传与运行追踪，并阻止通过 WebUI 自行升级或重启核心。公开模型元数据的启动查询没有独立关闭配置；查询失败不阻止核心启动。

检查、停止和查看帮助：

```powershell
.runtime\core\Scripts\python.exe scripts/tillith_dev.py status
.runtime\core\Scripts\python.exe scripts/tillith_dev.py stop
.runtime\core\Scripts\python.exe scripts/tillith_dev.py --help
```

修改客户端后重新执行 `npm.cmd run build`。运行目录、凭据和测试数据均在 Git 忽略范围内；启动器只显示凭据文件的位置。

## 连接与使用

在连接设置中选择“云端核心”，填写 Tillith 服务地址和具有 `chat`、`file` 权限的 API Key。客户端通过 `/api/v1/tillith/profile` 获取已有鉴权身份，再使用核心的会话、WebSocket 和文件接口；不需要为客户端创建另一套用户系统。

连接后可新建会话、发送消息或附件，返回会话列表查看历史并重命名会话。未配置模型时，可发送 `/help` 验证内置指令的真实往返。普通模型回复需要另外配置提供商；本轮未接入或验证外部 LLM，不把内置指令回复当成模型调用结果。

## Android 构建状态

Capacitor 壳与 `mobile/native-python` 嵌入入口仍在集成。Python 核心涉及多个原生二进制依赖，需要可用于目标 Android ABI 的构建产物及实机或模拟器验证。当前没有已验收可用的 APK，桌面上的嵌入启动成功不能代替手机运行验收。
