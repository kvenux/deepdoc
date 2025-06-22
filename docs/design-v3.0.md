好的，根据您提供的项目代码，我将为您生成一份关于Agent架构的设计文档。

---

## CodeWiki Agent 架构设计文档

### 1. 核心设计理念：解耦与分层

CodeWiki的Agent系统采用了严格的**分层和解耦**设计，旨在将**“用户意图”**与**“具体执行”**分离开来。这种架构使得系统具有高度的可扩展性、可维护性和可测试性。

其核心思想是将复杂的Agent执行流程拆分为三个主要层次：

1.  **UI/交互层 (UI/Interaction Layer)**: 负责接收用户输入和展示结果。
2.  **服务层 (Service Layer)**: 作为UI层和Agent核心逻辑之间的**唯一**桥梁（Façade模式）。
3.  **Agent核心层 (Agent Core Layer)**: 包含所有执行任务的实际逻辑、工具和模型交互。



#### 1.1. 解耦的具体实现

解耦是通过以下几个关键组件和服务实现的：

**A. `AgentService` (服务门面)**
*   **文件**: `extension/services/AgentService.ts`
*   **职责**: 这是UI层（如 `CodeWikiViewProvider` 或 VS Code 命令）与Agent系统交互的**唯一入口**。它隐藏了所有内部的复杂性。
*   **解耦点**:
    *   UI层不需要知道 `Orchestrator` 或 `Executor` 的存在。它只是调用一个简单的方法，如 `agentService.runProjectDocumentation(config)`。
    *   `AgentService` 负责根据调用的方法，**组装**Agent运行所需的一切依赖，包括选择合适的日志记录器（`WebviewLogger` 或 `VscodeOutputChannelLogger`）和创建 `AgentContext`。

**B. `AgentContext` (依赖注入容器)**
*   **文件**: `extension/agents/AgentContext.ts`
*   **职责**: 这是一个简单的数据结构，用于将所有Agent运行所需的**依赖项**（如 `llmService`, `toolRegistry`, `logger`, `modelConfig` 等）打包在一起。
*   **解耦点**:
    *   任何Agent组件（无论是编排器还是执行器）都通过构造函数接收 `AgentContext`。它们不关心这些依赖项是如何被创建或配置的，只管使用。
    *   这使得在测试中可以轻松地注入模拟（mock）的依赖项。
    *   通过可选的 `runDir` 属性，上层（如Orchestrator）可以向下层（Executor）传递运行时信息，而无需修改其签名。

**C. `ToolRegistry` (工具注册表)**
*   **文件**: `extension/services/ToolRegistry.ts`
*   **职责**: 在扩展激活时，统一初始化所有可用的工具（`fileSystemTools`, `llmTools`等）。
*   **解耦点**:
    *   Agent执行器（如 `ToolChainExecutor`）不直接创建或引用具体的工具类。
    *   它根据YAML中定义的工具名称，向 `ToolRegistry` 请求相应的工具实例 (`toolRegistry.getTools(['tool_name_1', 'tool_name_2'])`)。
    *   这使得添加新工具变得非常简单，只需在 `ToolRegistry` 中注册即可，无需修改任何Agent逻辑。

**D. `LLMService` (模型服务)**
*   **文件**: `extension/services/LLMService.ts`
*   **职责**: 集中管理所有与大语言模型（LLM）的交互。
*   **解耦点**:
    *   Agent和工具不直接与 LangChain 的 `ChatOpenAI` 或 `ChatGoogleGenerativeAI` 等具体模型类交互。
    *   它们通过 `llmService.createModel()` 获取一个通用的 `BaseChatModel` 实例。
    *   `LLMService` 内部处理了模型切换（例如，通过 `USE_GEMINI` 标志）、URL格式化等细节。
    *   更重要的是，它通过 `scheduleLlmCall` 方法实现了一个**请求队列和速率限制器**，这对于所有Agent都是透明的，避免了因API调用过于频繁而导致的错误。

**E. `AgentLogger` (日志记录器接口)**
*   **文件**: `extension/services/logging.ts`
*   **职责**: 定义了一个通用的日志记录接口（`info`, `error`, `log`等）。
*   **解耦点**:
    *   Agent在执行过程中，只与 `AgentLogger` 接口交互 (`context.logger.info(...)`)。
    *   它完全不知道日志最终是输出到VS Code的“输出”面板（`VscodeOutputChannelLogger`）还是通过 `postMessage` 发送到Webview（`WebviewLogger`）。
    *   这使得同一套Agent逻辑可以被用在不同的场景下（例如，后台命令执行 vs. Webview实时交互），并提供截然不同的用户反馈。

### 2. Agent 功能概览

目前，项目中有**1个高级编排器**和**2个基础执行器**，它们可以被视为不同类型的“Agent”或Agent的核心组件。

#### 2.1. `ProjectDocumentationOrchestrator` (项目文档编排器)

*   **文件**: `extension/agents/orchestrators/ProjectDocumentationOrchestrator.ts`
*   **类型**: **高级工作流Agent (Orchestrator)**
*   **功能**: 负责执行一个完整、多步骤的“生成项目文档”工作流。它不执行基础任务，而是**编排**和**调用**其他基础执行器来完成子任务。
*   **执行流程**:
    1.  **规划阶段 (Planning)**:
        *   使用 `get_directory_tree` 工具获取项目文件结构。
        *   调用LLM分析文件树，生成一个JSON格式的执行计划，包含项目名、语言和需要分析的核心模块列表（`{name, path, description}`）。
    2.  **分析阶段 (Analysis)**:
        *   对规划出的模块列表进行**过滤和去重**，移除路径重叠的模块（例如，如果已计划分析 `src/services`，则会跳过 `src`）。
        *   **并行**分析所有唯一的模块。
        *   对于每个模块，它会计算其代码总Token数，然后**动态选择**合适的执行器：
            *   如果Token数较少（低于`MAX_TOKENS_FOR_DIRECT_ANALYSIS`），则调用 `ToolChainExecutor` 进行直接分析。
            *   如果Token数过多，则调用 `MapReduceExecutor` 进行分批处理分析。
    3.  **综合阶段 (Synthesis)**:
        *   收集所有模块的分析文档。
        *   调用LLM将所有独立的模块文档整合成一篇结构完整、逻辑连贯的最终项目设计文档。
    4.  **输出**: 将最终文档保存到工作区的 `.codewiki/runs/...` 目录下，并提示用户打开。

#### 2.2. `ToolChainExecutor` (工具链执行器)

*   **文件**: `extension/agents/executors/ToolChainExecutor.ts`
*   **类型**: **通用基础Agent (Executor)**
*   **功能**: 负责解析和执行一个定义了 `tool_chain` 的Action Prompt (YAML格式)。它按顺序执行一系列工具，并将一个工具的输出作为下一个工具或最终LLM调用的输入。
*   **适用场景**: 适用于逻辑清晰、步骤线性的任务，例如“获取文件摘要 -> LLM筛选文件 -> 读取文件内容 -> LLM生成文档”。

#### 2.3. `MapReduceExecutor` (Map-Reduce 执行器)

*   **文件**: `extension/agents/executors/MapReduceExecutor.ts`
*   **类型**: **专用基础Agent (Executor)**
*   **功能**: 专门用于处理**超长上下文**（例如，一个包含大量代码文件的模块），当内容无法一次性放入LLM的上下文窗口时使用。
*   **执行流程**:
    1.  **Map阶段**: 将所有文件按Token数限制分成多个批次（batch）。并行地让LLM为每个批次生成独立的摘要或分析。
    2.  **Reduce阶段**: 将所有批次生成的摘要合并在一起，然后让LLM对这个合并后的内容进行最终的综合、提炼或生成最终报告。
*   **适用场景**: 对大型代码库、整个模块或多个文件进行全面分析和总结。

### 3. 工作流程示例：从Webview触发Action Prompt

1.  用户在Webview的输入框中输入 `/agent ...` 并点击发送。
2.  `ChatView.ts` 捕获到这个意图，将YAML内容、用户输入和模型配置打包，通过 `vscode.postMessage` 发送 `executeActionPrompt` 命令。
3.  `CodeWikiViewProvider.ts` 接收到消息，它**不会**自己处理，而是直接调用 `this._agentService.runActionFromWebview(...)`，将所有负载转交。
4.  `AgentService.ts` 开始工作：
    *   创建一个 `WebviewLogger` 实例，它知道如何将日志作为消息发回给Webview。
    *   组装一个 `AgentContext`，包含 `WebviewLogger`、`llmService`、`toolRegistry` 等。
    *   实例化 `ToolChainExecutor`（或其他未来可能支持的执行器），并将 `AgentContext` 注入。
5.  `ToolChainExecutor.ts` 开始执行：
    *   解析YAML，从 `toolRegistry` 获取所需工具。
    *   依次执行工具链中的每个工具。
    *   每次工具开始或结束时，它会调用 `context.logger.info(...)`。`WebviewLogger` 会将这些信息格式化为 `agentStatusUpdate` 消息发给Webview。
    *   当最终调用LLM并获取流式输出时，`ToolChainExecutor` 调用 `context.logger.log(chunk)`。`WebviewLogger` 会将每个 `chunk` 包装成 `streamData` 消息发给Webview。
6.  Webview的JS代码接收到 `agentStatusUpdate` 和 `streamData` 消息，并实时更新UI，向用户展示Agent的执行进度和结果。


新版需求：为agent做一个通用的前端聊天对话交互
要求：
1、为agent做通用的过程动态展示，在一个聊天框中动态展示
2、agent包括项目级文档生成、模块级文档-直接生成式（toolchain调用，需提供路径）、模块级文档-摘要总结式（map-reduce，需提供模块路径）
3、从聊天框输入中触发，输入@符号，弹出选项窗口，先给一类文档生成（之后会更多大类，考虑扩展），文档生成弹出三小类
4、选了响应命令之后，补充用户的需求（先不要处理这部分），按回车即开始生成
5、前端从agent展示工作流的具体过程步骤，包含哪几个提示词，整体流程是怎样的，根据当前三种agent的执行过程进行展示：- 分为哪几个步骤，每个步骤要用一个大卡片来区分
- 每个步骤的提示词是什么（提示词用小卡片显示xxx.yml）点击yml编辑区跳转到对应提示词，支持用户编辑
6、展示完过程，查看是否有参数需要用户提供，调用大模型解析用户的输入（例如模块路径），同时检查合法性（例如当前不存在路径），继续询问
7、如无需用户输入，则提供按钮start 和 cancel
8、点击cancel退出当前agent过程，聊天窗口只展示用户与大模型的交互区的文字记录
9、点击start开始执行，执行过程要有很强的交互，不能让用户空等，即主要是运行过程就要表现地很卖力，最好让用户知道你当前在干啥，在等啥输入
10、执行过程也要分阶段展示，当前阶段的任务是什么，输入是什么，输出是什么；输入要卡片展示；给大模型的request要单独卡片展示，支持可展开，大模型的回复也要卡片展示，支持可展开；输出要卡片展示，如果输出是markdown文档，要在卡片里显示临时文件名markdown，比如项目级文档生成过程中，每个模块的md文档就要卡片单独显示；比如当前子任务已完成，就显示md卡片，点击md卡片，编辑区跳转到对应md文档的临时文档
11、由于当前已经并行化，每个并行化的任务都要刷新状态，默认是折叠态、可以展开，比如大模型回复区，需要流式显示当前的回复；

基于以上需求，进行需求级的实现设计，输出需求实现设计文档，重点阐述UI\UX设计的需求澄清、功能设计、实现手段


好的，这是一个针对您提出的新需求的实现设计文档。文档将重点阐述UI/UX设计、功能设计，并提出具体的技术实现方案。

---

## Agent 通用对话式交互：需求实现设计文档

### 1. 需求澄清与 UI/UX 设计

本次的核心目标是将 Agent 的执行过程从一个黑盒（如后台输出通道）转变为一个在聊天界面中实时、可交互、高度可视化的“白盒”。用户不仅能触发 Agent，还能清晰地看到其思考和执行的每一步。

#### 1.1. 交互触发：`@`命令菜单

-   **需求**: 输入`@`符号，弹出选项窗口。
-   **UI/UX 设计**:
    -   当用户在聊天输入框中输入`@`时，立即在光标位置上方弹出一个浮层菜单（类似 GitHub 或 Slack 的用户提及）。
    -   菜单分为两级：
        1.  **第一级（大类）**: "文档生成" (未来可扩展为 "代码重构", "测试用例生成" 等)。
        2.  **第二级（子命令）**: "项目级文档", "模块级文档 (直接分析)", "模块级文档 (摘要总结)"。
    -   用户可以通过键盘上下键和回车，或鼠标点击来选择。
    -   选择后，`@命令` 会以一个特殊的“胶囊”（Pill）形式出现在输入框中，例如：`[@文档生成: 项目级]`，后面跟随用户的自然语言描述，如：“帮我分析一下这个项目的主要功能”。

    

#### 1.2. Agent 过程展示：两大核心UI块

为了将 Agent 的“配置阶段”和“执行阶段”清晰分开，我们引入两个新的聊天消息块类型。

**A. Agent 调用块 (Agent Invocation Block)**

-   **用途**: 当用户按下回车确认`@`命令后，在聊天窗口中出现此块。它是一个**交互式配置面板**，用于展示 Agent 的工作流并收集必要的参数。
-   **UI/UX 设计**:
    -   这是一个大型卡片，包含清晰的标题，如“**即将运行: 项目文档生成 Agent**”。
    -   **工作流预览区**:
        -   将 Agent 的主要执行阶段（如“规划”、“分析”、“综合”）显示为垂直排列的、带有编号的大型步骤卡片。
        -   每个步骤卡片内，简要描述该步骤的目标。
        -   如果步骤使用提示词，会显示一个**可点击的 YML 提示词卡片** (例如 `planner.yml`)。点击后，会向扩展发消息，在新的编辑器标签页中打开对应的 `.codewiki/*.yml` 文件，允许用户查看甚至**临时修改**。
    -   **参数区**:
        -   根据 Agent 的需求清单，显示需要用户提供的参数输入框（例如“模块路径”）。
        -   Agent 会尝试从用户的初始输入（`@命令`后面的文字）中**自动填充**这些参数。
        -   如果路径不存在或格式错误，输入框会高亮显示错误信息，并提示用户修改。
    -   **操作区**:
        -   如果所有必需参数都已满足，显示 **`[Start]`** 和 **`[Cancel]`** 按钮。
        -   如果还有参数缺失，`[Start]` 按钮会是禁用状态。
    -   **取消**: 点击 `[Cancel]` 或此块右上角的关闭按钮，整个“调用块”将从聊天记录中移除，只留下用户最初输入的那行 `@命令` 文本。

    

**B. Agent 执行块 (Agent Execution Block)**

-   **用途**: 用户点击 `[Start]` 后，“调用块”会转变为“执行块”。这是一个**实时日志和结果展示面板**。
-   **UI/UX 设计**:
    -   整体卡片标题变为“**正在运行: 项目文档生成 Agent**”，并带有一个旋转的加载图标。
    -   **阶段式可折叠视图**:
        -   执行过程按“规划”、“分析”、“综合”等阶段划分，每个阶段都是一个**默认折叠**的卡片。
        -   当前正在执行的阶段会自动展开，并显示绿色“正在运行”状态。已完成的阶段显示灰色“已完成”状态。
    -   **步骤细节展示**:
        -   在展开的阶段卡片内，每一步操作都以子卡片的形式实时追加。
        -   **并行任务**: 对于 Map-Reduce 的并行分析，会有一个“并行任务”容器，内部为每个批次（Batch）显示一行状态，如 `[Batch 1/5: ✔️ 完成]`, `[Batch 2/5: ⚙️ 分析中...]`, `[Batch 3/5: 🕒 等待中]...`。每一行都可以展开查看该批次的详细执行日志。
        -   **LLM 调用**: 对大模型的请求和响应会用专门的卡片展示。
            -   **Request 卡片**: 标题为 `[Request to LLM]`，默认折叠，可展开查看完整的 System 和 Human Prompt。
            -   **Response 卡片**: 标题为 `[Response from LLM]`，内容区域会**流式显示**LLM返回的文本。
        -   **文件输出**: 当 Agent 生成一个中间文件（如模块分析的 Markdown），会显示一个**文件卡片**，如 `[📄 module_services.md]`。点击此卡片，会向扩展发消息，在新的编辑器标签页中打开这个位于 `.codewiki/runs/...` 目录下的临时文件。
    -   **最终产出**: 整个流程结束后，卡片顶部状态变为“**✔️ 执行完成**”，并在底部显示最终的产出文件卡片（如 `[📄 项目总体设计文档.md]`）。

    

### 2. 功能设计

#### 2.1. Agent 定义与清单 (Manifest)

-   为了让前端能够动态渲染“调用块”，我们需要为每个 Agent 定义一个“清单”文件（例如 `project_doc_agent.manifest.json`）。
-   此清单将包含：
    -   `id`: `project-documentation`
    -   `displayName`: "项目级文档生成"
    -   `description`: "自动分析整个项目结构，生成高级设计文档..."
    -   `parameters`: [ { `name`: "user_goal", `type`: "string", `required`: true, `description`: "用户的目标描述" } ] // 项目级Agent可能只需要自然语言
    -   `workflow`: [
            { `phase`: "规划", `description`: "分析项目结构，制定分析计划。", `prompt`: "project_planner.yml" },
            { `phase`: "模块分析", `description`: "根据计划，并行分析各模块。", `prompt`: ["module_analysis_direct.yml", "module_analysis_mapreduce.yml"] },
            { `phase`: "综合", `description`: "汇总所有分析结果，生成最终文档。", `prompt`: "project_synthesis.yml" }
        ]

#### 2.2. 完整的端到端流程

1.  **触发**: 用户输入`@`，前端显示`@`命令菜单，用户选择`项目级文档`，输入“`@文档生成: 项目级` 帮我分析一下认证和授权模块的功能”，然后回车。
2.  **调用**:
    -   前端 Webview 将 `{ command: 'agent:invoke', payload: { agentId: 'project-documentation', text: '帮我分析一下...' } }` 发送给扩展。
    -   `AgentService` 接收到消息，加载对应的 `manifest.json`。
    -   `AgentService` 使用一个轻量级的LLM调用，尝试从用户输入文本中提取 `user_goal` 参数。
    -   `AgentService` 将 Agent 清单和已提取的参数发回给 Webview。
    -   Webview 渲染出“**Agent 调用块**”，并自动填入参数。
3.  **配置与启动**:
    -   用户在“调用块”中确认或修改参数。
    -   用户点击 `[Start]` 按钮。
    -   Webview 发送 `{ command: 'agent:start', payload: { agentId: 'project-documentation', params: { ... } } }`。
4.  **执行与反馈**:
    -   `AgentService` 实例化 `ProjectDocumentationOrchestrator`。
    -   **核心改造**: `Orchestrator` 和 `Executor` 在执行过程中，不再调用简单的 `logger.info()`，而是通过 `context.eventEmitter.emit('phaseStart', ...)`、`context.eventEmitter.emit('toolOutput', ...)` 等方式**发射结构化事件**。
    -   `AgentService` 监听这些事件，并立即将格式化后的状态更新 `postMessage` 给 Webview (`{ command: 'agent:updateState', payload: { executionState: ... } }`)。
    -   Webview 接收到状态更新，**增量渲染**“执行块”，例如追加一个日志、更新一个并行任务的状态、或流式更新LLM的响应内容。
    -   当有文件生成时，`Orchestrator` 发射 `fileGenerated` 事件，`AgentService` 将文件路径通知 Webview，Webview 渲染出可点击的文件卡片。
5.  **完成/取消**:
    -   执行成功后，`AgentService` 发送最终的完成状态。Webview 将“执行块”锁定为只读日志。
    -   若用户中途点击了取消按钮，Webview 发送 `agent:cancel`，`AgentService` 中止 Agent 执行，并通知 Webview 移除整个“执行块”。

### 3. 技术实现方案

#### 3.1. Webview (前端)

-   **状态管理**: 在 `ChatView` 的 `messages` 数组中，元素类型需要扩展为 `ChatMessage | AgentInvocationState | AgentExecutionState`。
-   **新组件**:
    -   `AtCommandMenu.ts`: 负责渲染和处理`@`命令的浮层菜单。
    -   `AgentInvocationBlock.ts`: 渲染“调用块”，处理参数输入和与后端的交互。
    -   `AgentExecutionBlock.ts`: 渲染“执行块”，接收并动态展示后端发来的状态更新。
    -   `WorkflowStepCard.ts`, `FileCard.ts`, `LLMCallCard.ts` 等子组件，用于构建两大核心UI块。
-   **交互逻辑**:
    -   输入框逻辑更新，以支持`@`命令的识别和胶囊（Pill）的渲染。
    -   实现对 `agent:updateState` 消息的监听，并找到对应的 `AgentExecutionBlock` 实例进行 `update(newState)` 调用。
    -   文件卡片和YML卡片的点击事件会触发新的 `postMessage`，如 `{ command: 'action:openFile', payload: { path: '...' } }`。

#### 3.2. Extension (后端)

-   **`AgentService` 大改造**:
    -   `runActionFromWebview` 将被 `invokeAgent` 和 `startAgent` 两个方法取代。
    -   需要引入一个事件发射器（如 Node.js 的 `EventEmitter`）到 `AgentContext` 中。
    -   `startAgent` 方法将不再是 `async/await` 等待其完成，而是启动后立即返回，通过监听内部事件来向前端发送更新。
-   **`Orchestrator` 和 `Executor` 重构**:
    -   所有 `logger.info/log` 调用都需要替换为发射具体的、结构化的事件。
    -   例如 `logger.info("> Executing tool: ${toolName}...")` 变为 `this.context.emitter.emit('stepStart', { type: 'tool', name: toolName, input: ... })`。
    -   并行任务需要为每个子任务分配唯一ID，并围绕此ID发射状态更新事件（`pending`, `running`, `success`, `error`）。
-   **新的 `PostMessage` 命令**:
    -   `agent:invoke`: 客户端请求展示一个Agent的调用块。
    -   `agent:start`: 客户端确认启动Agent。
    -   `agent:cancel`: 客户端请求中止Agent。
    -   `agent:updateState`: **服务端主动推送**，携带最新的执行树状态。
    -   `action:openFile`: 客户端请求在VS Code编辑器中打开一个文件。
-   **文件系统**:
    -   Agent 执行的所有临时产出（中间MD文件、LLM请求/响应日志等）都应保存在一个带时间戳的唯一运行目录中（例如 `.codewiki/runs/project-doc-20231027T103000Z/`），这使得文件卡片的点击跳转实现变得简单可靠。

通过以上设计，我们可以构建一个高度互动、透明且可扩展的 Agent 交互框架，极大地提升用户体验，并为未来集成更多、更复杂的 Agent 打下坚实的基础。