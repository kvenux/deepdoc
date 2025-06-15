### **详细设计文档 v2.3：可配置的 Agentic Workflow UI**

#### **1. 概述 (Overview)**

此版本旨在将 v2.2 中实现的 `CustomAgentExecutor` (后台 Agentic 能力) 与插件的前端 UI 和状态管理（Prompt 管理、聊天窗口）完全打通。用户将能够通过图形界面来管理、加载和执行这些强大的、带工具调用的 "Action Prompts"。

**核心目标：**

1.  **Prompt 管理升级**: 将“提示词管理”升级为“工作流管理”。`Prompt` 的 `content` 字段现在将存储完整的 YAML 格式的工作流定义。
2.  **动态参数 UI**: 当用户在聊天窗口选择一个工作流（Action Prompt）时，UI 会自动解析其 `input_variables` 并动态生成一个参数输入表单。
3.  **无缝的执行流程**: 用户填写参数后，点击“执行”，即可启动后端 Agent，并将用户输入、工作流定义和执行结果完整地记录到当前的对话历史中。

#### **2. 数据结构变更**

为了支持更丰富的输入类型，我们需要对 `common/types.ts` 中的 `Prompt` 定义进行扩展，但实际上，我们只需在**概念上**重新解释 `content` 字段，并让前端解析它即可。核心数据结构 `Prompt` 保持不变，以确保向后兼容。

`input_variables` 的 YAML 结构需要调整以更好地支持 UI 生成：

```yaml
# 示例: src/webview/views/ChatView.ts 中的测试 YAML 将被迁移到 Prompt 管理中

# input_variables 结构定义
input_variables:
  - name: module_path         # 唯一标识符，用于代码
    label: "模块路径"          # UI上显示的标签
    description: "要分析的模块/文件夹路径。" # UI上的提示信息
    type: "path"             # UI控件类型 ('text', 'textarea', 'path')
    
  - name: task_description
    label: "核心任务"
    description: "简要描述你想分析的核心任务是什么？"
    type: "textarea"
```

*   `label`: 新增，用于在 UI 上显示更友好的名称。
*   `description`: 作为输入框下方的提示文字或 placeholder。
*   `type`: 指导 UI 生成何种类型的输入控件。`path` 类型未来可以扩展为触发 VS Code 的文件/文件夹选择对话框。
*   `default` 已被移除，所有参数都需要用户明确输入。

#### **3. 后端 (Extension) 设计变更**

1.  **`StateManager.ts`**:
    *   `savePrompt(prompt: Prompt)`: 在保存之前，增加一个 YAML 验证步骤。
        *   使用 `js-yaml` 的 `load` 函数包裹在 `try-catch` 中。
        *   验证解析出的对象是否包含顶级的 `tool_chain` 和 `llm_prompt_template` 键。
        *   如果验证失败，**抛出一个错误**，阻止保存操作。这个错误将被 `CodeWikiViewProvider` 捕获并显示给用户。

2.  **`CodeWikiViewProvider.ts`**:
    *   `'savePrompt'` case:
        *   用 `try-catch` 包裹对 `this._stateManager.savePrompt(prompt)` 的调用。
        *   在 `catch` 块中，捕获到验证错误后，向前端发送一个错误消息（例如，通过 `vscode.window.showErrorMessage`），并**阻止**后续的 `showPromptManager` 导航，让用户可以继续编辑。
    *   `'sendMessage'` case:
        *   **移除**。这个 case 的职责将被一个新的、更通用的 `executeWorkflow` case 取代。
    *   `'executeWorkflow'` (新增 case):
        *   这个 case 将是新的核心入口，取代临时的 `executeActionPrompt` 和旧的 `sendMessage`。
        *   **Payload**: `{ conversationId: string | null, promptId: string, userInputs: Record<string, string>, modelConfig: ModelConfig }`
        *   **执行流程**:
            1.  **获取或创建对话**:
                *   如果 `conversationId` 存在，从 `StateManager` 加载该对话。
                *   如果为 `null`，创建一个新的 `Conversation` 对象。将其 `id` 和 `createdAt` 设置好。
            2.  **获取工作流定义**: 根据 `promptId` 从 `StateManager` 加载 `Prompt` 对象，并用 `yaml.load` 解析其 `content`。
            3.  **创建用户消息**: 创建一个新的 `ChatMessage` (`role: 'user'`)。其 `content` 不再是简单的文本，而是一个结构化的字符串，包含了工作流的标题和用户输入的参数，例如：
                ```
                ## Executing: 生成核心模块设计文档

                **Parameters:**
                - **模块路径:** src/extension
                - **核心任务:** 这个模块的核心功能是...
                ```
                将这个用户消息 `push` 到当前对话的 `messages` 数组中。
            4.  **初始化 Agent**: 使用 `modelConfig` 动态创建 `ChatOpenAI` 实例和 `CustomAgentExecutor`。
            5.  **定义回调**:
                *   `onLlmStart`: 创建一个空的 `assistant` 消息并 `push` 到对话的 `messages` 数组中。
                *   `onLlmStream`: 将 `chunk` 追加到这个 `assistant` 消息的 `content` 中。
                *   `onLlmEnd`: **关键步骤** - 调用 `this._stateManager.saveConversation(this._activeConversation)` 来持久化整个交互，包括用户消息和完整的助手回复。然后向前端发送 `updateHistory` 消息。
                *   其他回调（`onToolStart`, `onToolEnd`, `onError`）保持不变，用于向前端发送实时状态。
            6.  **运行 Agent**: 调用 `executor.run()`。

#### **4. 前端 (Webview) 设计变更**

1.  **`PromptEditorView.ts`**:
    *   在保存按钮的点击事件中，不再需要自己做验证。验证逻辑已移至后端。前端只需发送 `savePrompt` 命令。
    *   需要监听一个新的后端消息，例如 `promptSaveFailed`，当后端验证失败时，显示一个内联的错误提示，而不是 VS Code 的全局弹窗。

2.  **`ChatView.ts` - 核心交互变更**:
    *   **移除** `/agent` 临时触发器。
    *   **`promptSelector` 的 `change` 事件监听器**: 这是交互的核心。
        1.  当用户选择一个 Prompt (工作流) 时，触发此事件。
        2.  从 `this.prompts` 中找到完整的 `Prompt` 对象。
        3.  使用 `js-yaml` 解析其 `content`。
        4.  **动态生成参数表单**:
            *   在聊天输入框的**上方**（或一个专门的区域）动态创建一个 `<div>` 容器。
            *   遍历 YAML 中的 `input_variables` 数组。
            *   为每个变量，根据其 `type` (`text`, `textarea`)，在容器中生成一个 `<label>`, `<input>`/`<textarea>` 和一个 `<p>` (用于 `description`)。
            *   给每个输入控件添加 `data-name` 属性，值为变量的 `name`。
            *   显示这个参数表单，并可能隐藏原始的聊天输入框。
        5.  **修改“Send”按钮**: 按钮的文本变为“Execute”或“Run Workflow”。
    *   **“Execute”按钮的点击事件 (`handleSendOrSave` 的新逻辑)**:
        1.  **收集参数**: 遍历参数表单中的所有输入控件，读取它们的值，并构建一个 `userInputs` 对象，形如 `{ module_path: "...", task_description: "..." }`。
        2.  进行基本的客户端验证（例如，非空检查）。
        3.  获取当前 `_activeConversation` 的 ID (可能为 `null`)。
        4.  获取当前选择的 `promptId` 和 `modelConfig`。
        5.  **发送 `executeWorkflow` 消息**: 调用 `vscode.postMessage`，将上述所有信息作为 `payload` 发送给后端。
        6.  **清理 UI**: 发送消息后，移除动态生成的参数表单，恢复聊天窗口的正常状态，并显示一个表示“正在执行...”的加载状态。

3.  **`ChatView.ts` - 状态展示**:
    *   需要监听并处理新的 `agentStatusUpdate` 消息。
    *   可以在消息列表的底部临时追加一个状态显示区域，用于展示 "Executing tool: get_file_summaries..." 这样的实时反馈。这可以是一个简单的 `div`，其内容根据收到的消息动态更新。

#### **5. 工作流程总结**

1.  **用户 (Prompt 管理)**: 创建/编辑一个工作流 YAML -> 点击保存 -> 后端验证 YAML 语法 -> 保存成功/失败。
2.  **用户 (聊天窗口)**:
    *   从 "Prompt" 下拉菜单选择一个工作流（如“生成模块文档”）。
    *   **UI 自动响应**: 聊天窗口下方出现 "模块路径" 和 "核心任务" 两个输入框。
    *   用户填写这两个输入框。
    *   用户点击 "Execute"。
3.  **系统 (前端)**:
    *   收集输入参数。
    *   发送 `executeWorkflow` 消息给后端，包含所有上下文。
    *   UI 进入加载状态。
4.  **系统 (后端)**:
    *   接收消息，创建或加载对话。
    *   创建代表本次执行的 `user` 消息并存入对话。
    *   启动 Agent。
    *   通过回调实时向前端发送 Agent 状态和最终的 LLM 流式响应。
    *   执行结束后，保存完整的对话（包括用户输入和助手回复）。
5.  **系统 (前端)**:
    *   接收并渲染 Agent 状态和 LLM 响应。
    *   接收到 `updateHistory` 消息，刷新历史记录视图。

这个设计将插件从一个简单的聊天工具，**升级为一个可配置、可扩展、有状态的自动化工作流平台**，完全释放了 LangChain Agentic 架构的潜力。