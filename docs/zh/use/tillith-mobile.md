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

## 聊天界面

会话列表支持按名称搜索。聊天页上方的模型按钮可读取核心已有配置与可用聊天模型，选择会传入下一条消息；没有模型时会明确提示先配置核心。选择与未发送草稿按会话保留在当前页面运行期间，刷新或重新连接后重置。

回复支持 Markdown 表格、列表、引用与代码块，可复制完整回复或单个代码块；上传的图片可在应用内放大预览。向上阅读历史时，新片段不会强制滚动到底部，点击“回到最新”恢复跟随。输入框随内容增高，Ctrl/Cmd + Enter 发送消息，并避开输入法组合输入。

## Android 构建状态

`Build Tillith Android` 工作流现在产出固定证书签名的 release APK。仓库 Secrets 需要配置 `TILLITH_ANDROID_KEYSTORE_BASE64`（PKCS12 文件的 Base64）和 `TILLITH_ANDROID_KEYSTORE_PASSWORD`，证书别名固定为 `tillith-release`。签名材料单独私密保存，不提交到仓库；缺少签名时构建会失败。构建制品同时包含证书校验结果、APK SHA-256 和源代码提交号。

`target` 可选云端、内置或两者；内置包的 `embedded_abis` 可选 ARM64 或 ARM64/x86_64。`versionCode` 使用工作流运行编号，后续构建继续沿用同一证书。之前临时 debug 证书签名的安装包无法被新证书直接覆盖，迁移前需要保留旧应用中的数据。

手机基础核心使用 `mobile/native-python/mobile-requirements.txt`，保留聊天、人格、SQLite、内置插件、API 与附件依赖；上游完整服务端清单仍保存在 `requirements.txt`。外部聊天平台、Docker、FAISS 知识库索引与额外文档转换需要各自的依赖，不能因为插件能安装就假定它支持 Android。该精简环境已通过真实启动、消息与附件往返，以及关闭后的数据库持久化检查。

云端 release APK 已通过固定签名验证、13 条 Android 测试以及模拟器安装启动检查。ARM64 内置版已完成 Python 依赖安装、打包和签名，并核对包内后端源码；内置核心的手机实际启动仍待验证。x86_64 内置版尚未完成原生依赖验收。桌面上的嵌入启动成功不能代替手机运行验收。
