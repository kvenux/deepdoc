
### CodeWiki IDE 插件设计文档 (V2.0)

**版本**: 2.0
**修订日期**: 2025-06-14
**说明**: 本文档基于当前项目代码进行修订，准确反映了插件的实际功能与技术实现。

## 1. 工具概述

CodeWiki 是一个旨在将软件设计文档的生成和维护自动化的 IDE 插件。

**核心功能:** (与 V1.5 保持一致)
1.  **自动生成文档**: 扫描代码库（分析依赖、调用链、类关系等），自动为服务或组件生成设计文档。
2.  **代码与设计的双向追溯**: 提供一个交互图，方便在代码和设计文档之间来回跳转和查看。
3.  **自然语言问答**: 支持用自然语言提问（例如，“哪个 API 修改了用户信息？”），插件会在图中高亮显示相关的代码或设计元素。

## 2. 插件界面与核心功能

### 2.1. 侧边栏布局与交互

插件在 IDE 侧边栏提供一个名为 “CodeWiki” 的主视图，所有功能均在 **单一的 Webview** 内通过前端路由切换，实现无缝的单页应用 (SPA) 体验。

* **顶部图标栏**: 视图顶部设有一条水平工具栏，包含核心功能入口：
    * **新建对话** (`codicon-add`): 清空当前对话，开始一个全新的会话。
    * **对话** (`codicon-comment-discussion`): 返回当前或上一次的对话窗口。
    * **历史** (`codicon-history`): 查看并管理所有历史对话。
    * **提示词** (`codicon-symbol-keyword`): 管理和复用提示词模板。
    * **设置** (`codicon-settings-gear`): 配置模型 API 等参数。
* **视图切换**: 点击任一图标，下方的主内容区会立即切换到对应的功能面板。当前激活的图标会高亮显示。
* **欢迎页面**: 首次启动或未加载对话时，显示欢迎信息，引导用户开始操作。

### 2.2. 对话窗口

作为用户与大模型交互的核心界面，设计重点在于提供沉浸式、无干扰的交流体验。

* **消息布局与样式**:
    * **文档式流布局**: 每条消息均占满窗口宽度，消息之间由一条 `1px` 的、颜色较淡的分隔线 (`--vscode-editorGroup-border`) 区隔。
    * **呼吸空间**: 消息块保留适度的内边距 (`padding`)，确保文本易于阅读。
* **消息悬浮工具栏 (Hover Toolbar)**:
    * 当鼠标悬停在任一消息块上时，其右上角会平滑浮现一个快捷工具栏。
    * **通用功能**:
        * **折叠/展开**: 工具栏首个按钮 (`codicon-chevron-up`/`codicon-chevron-down`)，允许用户收起或展开消息内容，方便浏览长对话。
        * **复制**: 复制该条消息的完整内容到剪贴板。
    * **模型消息**: 额外包含 **“重新生成”** (`codicon-sync`) 图标。
    * **用户消息**: 额外包含 **“编辑”** (`codicon-pencil`) 图标。点击“编辑”后，该消息内容会加载到底部输入框，同时按钮变为“保存”，用户可修改后重新提交生成。
* **底部消息编辑区 (Sticky Input)**:
    * **固定布局**: 该区域固定在窗口最底部，无论聊天记录多长，用户都无需滚动即可随时输入。
    * **动态高度**: 输入框为多行文本域 (`<textarea>`)，高度会随内容增多而自动增长（有最大高度限制），超出后出现内部滚动条。
    * **操作按钮**:
        * **发送/停止/保存按钮**: 根据上下文动态变化，用于提交请求、中断流式响应或保存在编辑的消息。
        * **最大化编辑按钮** (`codicon-screen-full`): 用于解决底部编辑区空间有限的问题。
* **专注编辑模式 (Focus Editor Mode)**:
    * **触发与呈现**: 点击“最大化编辑”按钮后，会在 IDE 的主编辑区打开一个 **新的 Webview 面板** (`WebviewPanel`)。
    * **双向同步**: 专注编辑视图与侧边栏底部输入区的内容、模型选择、提示词选择 **严格保持双向同步**。在一个地方的任何修改，都会立即反映在另一个视图上。
    * **保留完整功能**: 此视图内完整保留了下方的 **快捷功能栏（提示词、模型选择）** 和 **发送按钮**。
    * **退出模式**: 在专注编辑视图中，原“最大化”按钮变为“恢复至侧边栏”图标 (`codicon-screen-normal`)，点击后关闭此 Webview 面板，焦点返回侧边栏。
* **快捷功能栏**:
    * **提示词模板**: 下拉菜单，选择后可将模板内容填充至输入框。
    * **模型选择**: 下拉菜单，用以切换当前对话使用的模型。
* **响应状态处理**:
    * **请求失败**: 若 API 请求失败，移除加载状态，在消息区显示错误提示。用户的原始消息会自动退回到底部编辑区，方便重试。
    * **用户中断**: 在流式响应期间点击“停止”按钮，内容流将立即中止。已接收的部分内容保留在消息区，并附加 `(Stopped)` 标记。

### 2.3. 对话管理 (历史视图)

* **列表项设计**:
    * 左侧为对话首句摘要，右侧为对话发起时间。
    * 鼠标悬停时有高亮背景，当前激活的对话有选中背景。
* **悬浮操作**:
    * 鼠标悬停时，列表项右侧浮现 **“删除”** 和 **“导出”** 两个图标按钮。

### 2.4. 提示词管理

此模块用于创建、组织和复用提示词模板，所有操作均在侧边栏 Webview 内完成。

* **主列表视图**:
    * **头部操作栏**: 包含 **“新建提示词”** 按钮和一个实时 **搜索框**。
    * **列表项设计**: 左侧为模板的 **标题** 和 **内容概要**，右侧为 **最后修改时间**。悬浮时右侧浮现 **“编辑”** 和 **“删除”** 按钮。
    * **空状态引导**: 列表为空时，显示引导文字和“新建提示词”按钮。

* **创建与编辑流程**:
    * **触发**: 点击“新建提示词”，或点击任一列表项/其“编辑”按钮。
    * **界面切换**: **当前 Webview 内容区会直接切换** 为提示词编辑表单，原列表视图被隐藏。
    * **编辑表单**: 包含“标题”输入框和“内容”文本域。
    * **操作按钮**: 表单上方有 **“保存”** 和 **“取消”** 按钮。
        * **保存**: 保存后，**自动切换回提示词列表视图**，并刷新列表。
        * **取消**: 点击后，若有未保存更改会弹窗确认，之后返回列表视图。

### 2.5. 设置

* **模型配置字段**: `模型名`, `Base URL`, `API Key`, `Model ID`。
* **存储方式**: `API Key` 等配置信息以 **明文形式** 存储在 VS Code 的 `globalState` 中。**此方案不提供加密，请勿存储生产环境或高度敏感的密钥。**
* **操作**: 支持新增、删除、修改和设置默认模型。

## 3. 模型交互与非功能性需求

(与 V1.5 基本一致，文字略作精炼)

### 3.1. 模型对话交互

* **流式响应与中断**: 点击“发送”后，按钮立即变为“停止”。模型响应以流式方式显示。用户可随时点击“停止”中断，已接收内容会保留并标记为 `(Stopped)`。
* **历史消息编辑**: 支持对用户发出的历史消息进行原地重新编辑。
* **错误处理与重试**: 请求失败时提供清晰错误反馈，并将用户输入内容退回编辑区以便重试。

### 3.2. 非功能性需求

* **性能**: 界面操作响应迅速，异步操作不阻塞 IDE 主线程。
* **易用性**: 界面设计直观简洁，符合 VS Code 用户习惯。
* **稳定性**: 插件自身运行稳定，无内存泄漏，不影响 IDE 性能。
* **一致性**: UI 风格与 VS Code 主题高度一致。

---

## 4. 代码实现规划与代码仓结构 (V2.0)

本章节蓝图精确对应当前代码库的结构与实现。

### 4.1. 技术选型

* **开发语言**: **TypeScript**。
* **核心框架**: **VS Code Extension API**。
* **UI 渲染**: **单一 WebviewView** + **原生 TypeScript/HTML/CSS**，构建一个轻量级单页应用 (SPA)。未使用大型前端框架。

### 4.2. 架构设计

插件采用 **Extension Host (后端) + 单一 WebviewView (前端)** 的高度集成架构。

* **Extension Host**: 后端逻辑核心。
    * **职责**:
        1.  注册 `CodeWikiViewProvider`，管理唯一的 Webview 实例和 `WebviewPanel` (用于专注编辑模式)。
        2.  通过 `StateManager` 模块作为数据中心，管理对话历史、提示词和模型配置。
        3.  通过 `LLMService` 模块作为服务代理，处理对大模型后端的 API 请求。
        4.  作为消息总线，监听并响应来自 Webview 的所有指令。
        5.  执行 VS Code 原生 API 调用，如显示信息、警告框等。

* **WebviewView**: 前端 UI 核心。
    * **职责**:
        1.  实现一个小型前端应用 (`App.ts`)，包含一个 `MapsTo` 方法充当路由器，根据用户点击渲染不同视图。
        2.  将所有用户操作转换为消息，通过 `vscode.postMessage()` 发送给 Extension Host。
        3.  监听来自 Extension Host 的消息，并据此更新 UI 状态和数据。

### 4.3. 代码仓结构详解

```plaintext
.
├── package.json
├── tsconfig.json
└── src/
    ├── common/
    │   ├── default-models.json   # 插件首次运行时的默认模型配置
    │   └── types.ts              # 核心：定义所有通信消息和数据模型接口
    │
    ├── extension/                # Extension Host (后端) 的所有代码
    │   ├── extension.ts          # 插件激活入口
    │   ├── CodeWikiViewProvider.ts # 核心：Webview 提供者，后端消息路由中心
    │   ├── StateManager.ts       # 数据状态管理器，封装 globalState
    │   └── LLMService.ts         # 大模型服务代理
    │
    └── webview/                  # Webview (前端) 的所有代码
        ├── main.ts               # 前端应用入口
        ├── vscode.ts             # 封装 acquireVsCodeApi
        │
        ├── views/                # 存放各个主功能视图的类
        │   ├── App.ts            # 根组件，包含顶部工具栏和路由逻辑
        │   ├── WelcomeView.ts
        │   ├── ChatView.ts       # 对话窗口视图
        │   ├── ChatHistoryView.ts# 对话历史视图
        │   ├── PromptManagerView.ts# 提示词管理视图
        │   ├── PromptEditorView.ts # 提示词编辑器视图 (在 Webview 内)
        │   ├── SettingsView.ts   # 设置视图
        │   └── FocusEditorView.ts# 专注编辑模式视图
        │
        ├── components/           # 存放可复用的 UI 小组件
        │   └── MessageBlock.ts   # 单条消息块组件
        │
        └── css/
            └── main.css          # 全局样式文件
```


我们继续实现需求
当前阶段的目标是实现模块级的详细设计文档

总体目标是实现一个代码仓的软件设计文档，包括模块架构、模块详细设计、接口、交互模型、并发模型等。
实现的步骤是：
整体分析、分析关键文件、规划有哪些模块
为每个模块生成一个设计文档
然后基于每个模块的设计文档，生成模块功能、模块架构，乃至其它设计要素，包括接口、数据模型、交互模型、并发模型等
其中需要依赖CleanArch工具，这个外部工具会利用程序分析手段进行依赖分析，生成函数调用链、模块架构图、依赖关系、类图继承关系等作为生成要素时候的上下文
上下文还包括模块代码结构、代码文件等，这些和cleanarch一起都属于提示词拼接时，需要准备好给大模型的

设计要素分析关键依赖如下图：

```plantuml
@startuml
title 设计要素依赖关系图

!theme vibrant
hide circle
skinparam rectangle {
    StereotypeFontColor #white
    StereotypeFontSize 12
}
skinparam arrow {
    Color #666666
    Thickness 1.5
}

' ---------- 输入源 ----------
package "输入源 (Source Artifacts)" #Technology {
    entity "<b>代码仓库</b>\n(Source Code)" as SRC
    entity "<b>接口定义</b>\n(API Spec YAML)" as YAML
    entity "<b>数据库结构</b>\n(SQL Files)" as SQL
}

' ---------- 程序分析产物 ----------
package "程序分析产物 (Analysis Outputs)" #Application {
    entity "模块架构图" as ArchDiagram
    entity "函数调用链" as CallChain
    entity "类图/继承关系" as ClassDiagram
    entity "代码依赖关系" as CodeDeps
}

' ---------- 最终文档章节 ----------
package "设计文档关键要素 (Design Document Elements)" #Business {
    entity "功能清单" as FuncList
    entity "实现模型" as ImplModel
    entity "接口" as InterfaceDoc
    entity "数据模型" as DataModel
    entity "算法实现" as Algo
    entity "交互模型" as InteractionModel
    entity "并发模型" as ConcurrencyModel
}

' ---------- 依赖关系 ----------
SRC --> CodeDeps
SRC --> ClassDiagram
SRC --> ArchDiagram
SRC --> CallChain

CodeDeps --> ImplModel
ArchDiagram --> ImplModel
ClassDiagram --right-> ImplModel

YAML -l-> FuncList
ImplModel -up-> FuncList

YAML --> InterfaceDoc
SRC --> InterfaceDoc

SQL --> DataModel
SRC --> DataModel

SRC --> Algo
CallChain -up-> Algo

CallChain --> InteractionModel

SRC --> ConcurrencyModel
CallChain -right[#red,dashed]-> ConcurrencyModel : 周边接口交互

@enduml
```

