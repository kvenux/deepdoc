好的，这是一个基于您提供的项目文件生成的详细设计文档。

### **CodeWiki 项目设计文档**

本文档旨在为开发者提供一个关于 CodeWiki VS Code 扩展的全面概览，包括其核心架构、各模块功能以及关键的交互流程，以作为理解和进一步开发项目的“地图”。

---

### **1. 核心架构概览**

CodeWiki 采用标准的 VS Code 扩展模型，其架构主要分为两大部分：

1.  **Extension Host (扩展主机 / 后端)**:
    *   运行在 Node.js 环境中，拥有访问 VS Code API 和本地文件系统的权限。
    *   负责处理核心业务逻辑，如：调用大语言模型 (LLM)、管理状态（聊天记录、配置）、执行文件操作、运行 Agent 工具链。
    *   代码位于 `src/extension/` 目录下。

2.  **Webview (前端)**:
    *   运行在 VS Code 的一个隔离的 Web 环境（类似浏览器）中，负责用户界面的渲染和交互。
    *   它不能直接访问 VS Code API 或文件系统，必须通过消息传递与 Extension Host 通信。
    *   代码位于 `src/webview/` 目录下。

3.  **通信桥梁**:
    *   两者之间的通信通过 `postMessage` API 进行。
    *   `src/common/types.ts` 文件定义了通信消息 (`PostMessage`) 和核心数据模型的 TypeScript 接口，确保了前后端之间数据交换的类型安全和一致性。

---

### **2. 文件夹结构与文件功能**

以下是项目的文件结构及其核心功能说明：

```
src
├── common
│   └── types.ts            # (通信与数据模型) 定义了前后端共享的 TypeScript 接口，如 PostMessage, Conversation, ModelConfig 等，是数据交互的契约。
├── extension
│   ├── agents
│   │   └── CustomAgentExecutor.ts # (Agent核心) 自定义的 Agent 执行器。负责按顺序执行工具链 (Tool Chain)，管理和传递上下文，并最终调用 LLM 生成结果。
│   ├── tools
│   │   ├── fileSystemTools.ts   # (文件系统工具) 定义了 Agent 可用的、与文件系统交互的工具，如获取文件摘要、读取文件内容。
│   │   └── llmTools.ts          # (LLM工具) 定义了“以LLM为工具”的特殊工具，如使用 LLM 来智能筛选文件列表。
│   ├── CodeWikiViewProvider.ts # (后端总控中心) 插件后端的核心。负责创建和管理 Webview，作为前后端消息的中转站 (handleMessage)，并协调 LLMService, StateManager 和 AgentExecutor。
│   ├── LLMService.ts           # (LLM服务) 封装了对 LangChain 和大模型 API 的调用。处理流式响应、请求中止和 API URL 的正确配置。
│   ├── StateManager.ts         # (状态管理器) 负责所有持久化数据的读写，包括聊天记录、模型配置和用户提示词，使用 VS Code 的 Memento API 进行存储。
│   └── extension.ts          # (插件入口) VS Code 加载插件的起点。主要工作是注册 CodeWikiViewProvider。
├── test
│   └── suite
│       └── index.ts          # (测试) 测试套件的入口文件。
└── webview
    ├── components
    │   └── MessageBlock.ts     # (UI组件) 负责渲染单条聊天消息（用户或助手的），包含消息内容和工具栏（复制、编辑等）。
    ├── css
    │   └── main.css          # (样式) 插件界面的所有 CSS 样式。
    ├── views
    │   ├── App.ts              # (前端总控中心) Webview UI 的根组件。负责初始化所有视图、处理来自后端的事件、并在不同视图（聊天、设置、历史等）之间导航。
    │   ├── ChatHistoryView.ts  # (UI视图) 渲染聊天历史列表。
    │   ├── ChatView.ts         # (UI视图) 核心的聊天界面。处理用户输入、消息显示、模型/提示词选择，并发起聊天请求。
    │   ├── FocusEditorView.ts  # (UI视图) “焦点模式”或“最大化”的输入编辑器，是一个独立的 Webview Panel。
    │   ├── PromptEditorView.ts # (UI视图) 用于创建和编辑提示词模板的表单界面。
    │   ├── PromptManagerView.ts# (UI视图) 用于展示、搜索和管理所有提示词模板的列表界面。
    │   ├── SettingsView.ts     # (UI视图) 用于添加、编辑和删除模型配置的设置界面。
    │   └── WelcomeView.ts      # (UI视图) 初始的欢迎界面。
    ├── main.ts               # (前端入口) Webview 中 JavaScript 的执行起点，负责实例化 App。
    └── vscode.ts             # (前端通信) 对 VS Code 提供的 `acquireVsCodeApi` 的一层薄封装，提供类型安全的 `vscode.postMessage` 方法。
```

---

### **3. 关键交互流程**

下面描述了几个核心功能的工作流程，展示了各模块如何协同工作。

#### **流程 1：用户发送一条普通聊天消息**

1.  **用户操作 (Webview)**:
    *   用户在 `ChatView` 的输入框中输入问题，点击 "Send" 按钮。

2.  **前端处理 (`ChatView.ts`)**:
    *   `handleSendMessage` 方法被触发。
    *   获取输入内容、选中的模型配置 (`ModelConfig`)。
    *   通过 `vscode.postMessage` 发送一个 `command: 'sendMessage'` 的消息到 Extension Host，附带问题内容和模型配置。

3.  **后端处理 (`CodeWikiViewProvider.ts`)**:
    *   `handleMessage` 方法接收到消息。
    *   根据 `command` 进入 `'sendMessage'` 分支。
    *   创建或更新当前的对话 (`Conversation`) 对象。
    *   调用 `LLMService.getCompletion()` 方法，并传入消息历史、模型配置以及三个关键的回调函数：`onData`, `onEnd`, `onError`。

4.  **LLM 调用与流式返回 (`LLMService.ts`)**:
    *   `getCompletion` 方法使用 LangChain 的 `ChatOpenAI` 实例，向模型 API 发起流式请求。
    *   当接收到数据块 (chunk) 时，通过 `onData` 回调函数将数据块传回 `CodeWikiViewProvider`。

5.  **数据流回前端 (Webview)**:
    *   `CodeWikiViewProvider` 在 `onData` 回调中，通过 `webview.postMessage` 将收到的数据块以 `command: 'streamData'` 的形式实时发送回 `ChatView`。
    *   `ChatView` 监听消息，在 `streamData` 事件中不断将内容追加到最后一条助手消息上，实现打字机效果。

6.  **完成与保存 (后端 -> 前端)**:
    *   LLM 响应结束，`LLMService` 调用 `onEnd` 回调。
    *   `CodeWikiViewProvider` 在 `onEnd` 中，将完整的对话内容通过 `StateManager.saveConversation` 保存。
    *   保存后，向 `ChatView` 发送 `command: 'streamEnd'` 和 `command: 'updateHistory'` 消息，以更新 UI 状态和历史列表。

#### **流程 2：执行一个 Action Prompt (Agent 工作流)**

这是一个更复杂的流程，展示了 Agent 的能力。

1.  **用户操作 (Webview)**:
    *   用户在 `ChatView` 输入框中输入 `/agent` (当前版本的临时触发方式)。

2.  **前端触发 (`ChatView.ts`)**:
    *   `handleSendMessage` 检测到 `/agent` 命令。
    *   它加载一个**硬编码的 YAML** 定义，其中包含 `tool_chain` 和 `llm_prompt_template`。
    *   通过 `vscode.postMessage` 发送 `command: 'executeActionPrompt'` 消息，附带 YAML 内容、用户输入和模型配置。

3.  **后端 Agent 初始化 (`CodeWikiViewProvider.ts`)**:
    *   `handleMessage` 接收到消息，进入 `'executeActionPrompt'` 分支。
    *   解析 YAML，获取工具链步骤和最终的提示词模板。
    *   **动态创建**一个新的 `ChatOpenAI` 实例，使用用户在 UI 上选择的模型配置。
    *   用这个新的 LLM 实例和预定义的工具集，创建一个 `CustomAgentExecutor` 实例。

4.  **Agent 执行 (`CustomAgentExecutor.ts`)**:
    *   调用 `agentExecutor.run()` 方法。
    *   **循环执行工具链**:
        *   **Step 1**: 调用 `get_file_summaries` 工具，将 `module_path` (来自用户输入) 作为参数。执行结果（文件摘要字符串）存入内部 `context` 中，变量名为 `all_file_summaries`。
        *   **Step 2**: 调用 `file_selector_llm_tool` 工具。它将上一步的 `all_file_summaries` 和用户任务描述 `task_description` 传给一个内部 LLM，该 LLM 智能地返回一个相关文件列表。结果（文件路径数组）存入 `context`，变量名为 `selected_files_list`。
        *   **Step 3**: 调用 `get_files_content_by_list` 工具，将上一步的 `selected_files_list` 作为参数。执行结果（所有文件的完整内容）存入 `context`，变量名为 `selected_files_content`。
    *   在每个工具执行前后，通过回调函数 (`onToolStart`, `onToolEnd`) 将状态（如“正在执行工具X...”）发送回前端进行展示。

5.  **最终 LLM 调用**:
    *   工具链执行完毕，`context` 中已包含了所有需要的信息。
    *   `CustomAgentExecutor` 使用 `llm_prompt_template` 和 `context` 构建最终的、非常详细的 Prompt。
    *   调用主 LLM (在步骤3中创建) 并将最终的生成结果以流式方式通过 `onLlmStream` 回调返回。

6.  **结果返回前端 (Webview)**:
    *   `CodeWikiViewProvider` 将 `onLlmStream` 的数据块以 `command: 'streamData'` 发送回 `ChatView`。
    *   `ChatView` 渲染最终的、由 Agent 生成的设计文档。


现在需要进行不同提示词的优化，通过前后端都改的形式太麻烦了，进行简化：
1、保持在vscode中运行，不要通过node或者ts-node运行
2、提供后端的入口，不要通过前端触发，提供脚本，在vscode运行时，提供入口调用
3、后端直接提供action prompt，调用agent执行过程，需要命令行打印流程关键信息
4、通过命令行查看执行过程，返回内容直接输出在本地文件夹中

先思考给出修改思路，先不要给代码