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
12、保留原先从从命令CodeWiki: Generate Project Documentation入口，保留传统的命令入口的output方式，用户调试

基于以上需求，进行需求级的实现设计，输出需求实现设计文档，重点阐述UI\UX设计的需求澄清、功能设计、实现手段


好的，这是一份基于您提出的新需求的实现设计文档。

---

## **CodeWiki Agent 通用聊天交互需求实现设计文档**

### 1. 需求澄清与 UI/UX 设计

本次需求的核心是将强大的 Agent 能力从后台命令迁移到用户更熟悉、交互性更强的聊天界面中。设计的关键在于如何在一个线性的聊天流中，清晰地展示和控制一个复杂的、非线性的、多步骤的 Agent 执行过程。

#### 1.1. 交互流程总览

用户与 Agent 的交互被划分为三个 distinct 阶段：

1.  **触发与规划 (Trigger & Planning)**: 用户通过 `@` 符号发起意图，系统展示一个可视化的执行计划，并确认必要参数。
2.  **实时执行 (Live Execution)**: 用户点击“开始”后，计划视图转变为一个动态更新的执行日志视图，实时反馈每一步的进展。
3.  **完成或取消 (Completion / Cancellation)**: Agent 执行完毕，展示最终产物；或用户中途取消，视图收起，保留最初的触发记录。

#### 1.2. UI/UX 细节设计

**A. 触发机制：`@` 命令菜单**

*   **交互**: 在聊天输入框中输入 `@` 符号。
*   **UI**: 立即在输入框上方弹出一个浮动菜单。
    *   菜单分层级，第一层为大类，如 `文档生成`。
    *   鼠标悬停或点击 `文档生成`，会展开第二层菜单，显示三个具体的 Agent 选项：
        *   `项目级文档生成`
        *   `模块级文档 (直接分析)`
        *   `模块级文档 (摘要总结)`
*   **选定后**: 用户选择一个 Agent 后，该命令（如 `@项目级文档生成`）会作为一个“Pill”（胶囊）插入到输入框。用户可以在后面继续输入自然语言描述，如：`@项目级文档生成 为我的这个电商后端项目写个文档`。

**B. 新增核心UI组件：`AgentRunBlock`**

这不再是一个简单的消息块，而是一个存在于聊天流中的、具有内部状态和复杂渲染逻辑的**“智能小程序”**。它将承载“规划”和“执行”两个阶段的视图。

**C. 阶段一：Agent 规划视图 (The "Planning" View)**

当用户按下回车发送 `@` 命令后，一个新的 `AgentRunBlock` 会被创建并显示在聊天界面中，初始状态为“规划中”。

*   **整体布局**: 一个带有特殊边框和背景色的大卡片，以区别于普通聊天消息。
*   **顶部标题**: "Agent 准备就绪: [Agent 名称]"。
*   **工作流展示区**:
    *   将 Agent 的执行流程分解为多个**步骤卡片 (Step Card)**，垂直排列。
    *   每个步骤卡片包含：
        *   **步骤编号和标题**: 例如 `[步骤 1/3] 规划：分析项目结构`。
        *   **描述**: 简要说明该步骤的目标。
        *   **提示词卡片 (Prompt Card)**: 如果该步骤使用了一个或多个 `.yml` 提示词，则将它们显示为小型的、类似标签的卡片。
            *   **UI**: 显示文件名，如 `project_planner.yml`，并带有一个小铅笔图标。
            *   **交互**: 点击该卡片，会向扩展后端发送一个消息，要求在新的编辑器标签页中打开对应的 `.yml` 文件，允许用户在执行前查看和修改。

*   **参数确认区 (Parameter Section)**:
    *   **自动解析**: 后端会尝试用 LLM 从用户的初始输入中解析出所需参数（如模块路径）。
    *   **UI 展示**:
        *   如果参数已满足（如路径 `src/api` 存在），则显示为：`模块路径: [src/api]` (已验证 ✔️)。
        *   如果需要参数但用户未提供，则显示一个输入框：`模块路径: [___________] (必需)`。
        *   如果解析出的参数不合法（如路径不存在），则显示错误信息和输入框：`模块路径: [src/non-existent] (路径不存在 ❌，请重新输入)`。
    *   系统会在此阶段与用户交互，直到所有必需参数都合法为止。

*   **控制按钮**:
    *   在视图底部，始终显示两个按钮：**`[▶️ 开始执行]`** 和 **`[⏹️ 取消]`**。
    *   `开始执行` 按钮在所有参数验证通过前为禁用状态。

**D. 阶段二：Agent 实时执行视图 (The "Live Execution" View)**

用户点击 `开始执行` 后，同一个 `AgentRunBlock` 的内容会**完全替换**为“实时执行”视图。

*   **整体布局**: 保持大卡片容器，但内部结构变化。步骤卡片现在是**可折叠**的（Accordion 风格）。默认只展开当前正在执行的步骤。
*   **步骤卡片 (Step Card) 的动态更新**:
    *   **状态指示器**: 每个步骤标题旁边都有一个状态图标：
        *   `⏳ 运行中`
        *   `✅ 已完成`
        *   `❌ 失败`
        *   `🕒 等待中`
    *   **详细内容（展开后）**:
        *   **任务 (Task)**: 清晰描述当前子任务，如 `Executing tool: get_directory_tree`。
        *   **输入 (Input)**: 将任务的输入参数格式化为卡片。例如，`{ path: '.', language: 'unknown' }` 会被展示为一个代码块卡片。
        *   **LLM 请求 (LLM Request)**: 如果有 LLM 调用，会显示一个**可展开的卡片** `[LLM Request]`。展开后，清晰地展示 `System Prompt` 和 `Human Prompt` 的内容。
        *   **LLM 响应 (LLM Response)**: 同样是一个**可展开卡片**。
            *   **流式显示**: 当 LLM 响应正在流式返回时，卡片内容会实时追加，给用户强烈的“正在工作”的感觉。
            *   **并行处理**: 对于 Map-Reduce 阶段，会同时显示多个 `[MAP] Batch X/Y` 的状态卡片，每个卡片内部可以独立更新自己的状态和结果。
        *   **输出 (Output)**: 任务的最终输出。
            *   **文件卡片 (File Card)**: 如果输出是一个 Markdown 文档（例如，每个模块的分析结果），则显示为一个文件卡片，如 `module_services.md`。点击该卡片，会向后端发送消息，要求打开这个位于 `.codewiki/runs/...` 目录下的临时文件。

*   **取消操作**: 在 `AgentRunBlock` 的右上角，提供一个全局的 `[⏹️ 终止]` 按钮，允许用户随时停止整个 Agent 的执行。

### 2. 核心功能设计

为了实现上述 UI/UX，我们需要对前后端进行相应的改造。

#### 2.1. Webview (Frontend) 设计

1.  **`ChatView.ts` 改造**:
    *   **@ 触发器**: 监听输入框的 `input` 事件，检测到 `@` 时，根据预定义的 Agent 列表渲染浮动菜单。
    *   **Agent 命令提交**: 当用户回车时，如果输入框内容包含 Agent 命令，则不作为普通消息发送，而是向后端发送一个新的 `agent:start` 消息，附带完整的用户输入文本。
    *   **`AgentRunBlock` 管理**: `ChatView` 将负责在消息列表中创建和销毁 `AgentRunBlock` 组件。它会持有一个 `activeAgentRun` 的状态，确保一次只有一个 Agent 在运行。

2.  **新增 `AgentRunBlock.ts` 组件**:
    *   **状态管理**: 该组件内部管理自己的状态，包括 `status` (`planning` | `executing` | `done` | `cancelled` | `error`)、`agentDefinition` (包含步骤、提示词信息)、`executionLog` (包含每一步的输入输出)等。
    *   **渲染逻辑**: 包含 `renderPlanningView()` 和 `renderExecutingView()` 两个核心方法，根据当前状态进行渲染。
    *   **事件处理**: 处理内部的点击事件（如点击 `.yml` 卡片、`Start`、`Cancel` 按钮），并转换为发往后端的 `postMessage`。

3.  **新增 `postMessage` 命令 (Webview -> Extension)**:
    *   `agent:start`: `{ command: 'agent:start', payload: { agentId: 'docgen-project', userInput: '为我的项目生成文档' } }`
    *   `agent:execute`: `{ command: 'agent:execute', payload: { agentId: '...', parameters: { ... } } }`
    *   `agent:cancel`: `{ command: 'agent:cancel', payload: { ... } }`
    *   `agent:openFile`: `{ command: 'agent:openFile', payload: { filePath: '.codewiki/prompts/planner.yml' } }`

#### 2.2. Extension (Backend) 设计

1.  **`CodeWikiViewProvider.ts` (消息路由)**:
    *   新增 `case 'agent:start'`: 接收到后，调用 `AgentService` 的新方法 `prepareAgentRun`，并将 `webview` 实例传递过去。
    *   新增 `case 'agent:execute'`: 调用 `AgentService.executeAgentRun`。
    *   新增 `case 'agent:openFile'`: 使用 `vscode.workspace.openTextDocument` 和 `vscode.window.showTextDocument` 打开指定文件。

2.  **`AgentService.ts` (核心调度器)**:
    *   **`prepareAgentRun(agentId, userInput, webview)`**:
        1.  根据 `agentId` 加载 Agent 的元数据（定义了步骤、提示词、所需参数）。
        2.  **(可选) LLM 调用**: 使用一个简单的 LLM prompt 来从 `userInput` 中提取参数。
        3.  创建一个 `WebviewLogger` 实例。
        4.  向 Webview 发送 `agent:showPlan` 消息， payload 包含 Agent 元数据和已解析/待填写的参数。
    *   **`executeAgentRun(agentId, parameters, webview)`**:
        1.  根据 `agentId` 选择要实例化的 `Orchestrator` 或 `Executor`。
        2.  创建包含 `WebviewLogger` 的 `AgentContext`。
        3.  调用相应 Agent 的 `run` 方法。

3.  **Agent Core (`Orchestrator`/`Executor`) 改造**:
    *   **粒度化日志**: `run` 方法需要被重构，以发出更结构化的事件，而不仅仅是打印字符串。
    *   `AgentLogger` 接口需要扩展，以支持结构化事件。

4.  **`AgentLogger` 接口扩展与 `WebviewLogger` 实现**:
    *   **新接口方法**:
        ```typescript
        interface AgentLogger {
            // ... existing methods
            startStep(stepInfo: { name: string; description: string }): void;
            logInput(stepName: string, input: any): void;
            logOutput(stepName: string, output: any, metadata?: { type: 'file', path: string }): void;
            logLlmRequest(stepName: string, request: { system: string; human: string }): void;
            logLlmStreamChunk(stepName: string, chunk: string): void;
            endStep(stepName: string, status: 'success' | 'failure'): void;
        }
        ```
    *   **`WebviewLogger` 实现**:
        *   每个新的接口方法都会被实现为向 Webview 发送一个特定的 `postMessage`。例如，`logInput` 会发送 `agent:update` 消息，其 `payload` 包含 `stepName` 和要更新的 `input` 数据。`logLlmStreamChunk` 会发送 `agent:streamChunk` 消息。

5.  **新增 `postMessage` 命令 (Extension -> Webview)**:
    *   `agent:showPlan`: `{ command: 'agent:showPlan', payload: { agentDefinition: {...}, parameters: {...} } }`
    *   `agent:update`: `{ command: 'agent:update', payload: { stepName: '...', update: { status: 'running', input: {...} } } }` (一个通用的更新命令)
    *   `agent:streamChunk`: `{ command: 'agent:streamChunk', payload: { stepName: '...', chunk: '...' } }`
    *   `agent:runFinished`: `{ command: 'agent:runFinished', payload: { status: 'success' | 'error', finalOutput: '...' } }`

### 3. 实现手段

*   **前端**:
    *   使用 `lit-html` 或类似的轻量级模板引擎来高效地渲染和更新复杂的 `AgentRunBlock` 组件，避免手动操作大量 DOM。
    *   CSS 将大量使用 Flexbox 和 Grid 布局来构建卡片式 UI。`--vscode-` 变量将确保 UI 风格与 VS Code 保持一致。
    *   `@` 菜单将通过绝对定位的 `div` 实现，并根据输入框位置动态计算。
*   **后端**:
    *   Agent 的元数据（步骤、提示词等）可以定义在单独的 `JSON` 或 `YAML` 文件中，方便管理和扩展新的 Agent。
    *   `AgentService` 将扮演更重要的角色，成为一个真正的 Agent 调度中心。
    *   对现有 `Orchestrator` 和 `Executor` 的改造是关键，需要细心地将原本线性的 `logger.info` 调用替换为结构化的 `logger.startStep`, `logger.logInput` 等事件发射。

### 4. 保留现有功能

*   `codewiki.generateProjectDocumentation` 命令的入口将保持不变。
*   在其处理函数 (`extension.ts`) 中，它会像现在一样，**实例化一个 `VscodeOutputChannelLogger`** 并传递给 `AgentService`。
*   `AgentService` 和核心 Agent 逻辑通过依赖注入的 `AgentLogger` 接口与日志实现解耦，因此它们无需任何改动即可同时支持新的 Webview 交互和旧的 Output Channel 输出。**这是我们架构解耦优势的最佳体现。**


好的，这是一个基于现有架构，分阶段、可实施的新需求开发计划。

---

## **CodeWiki Agent 通用聊天交互 - 开发计划**

本计划将新需求的开发分为三个主要阶段，旨在最大化地利用现有架构，降低风险，并实现平稳迭代。每个阶段都包含详细的任务列表和明确的验收标准。

### **阶段一：后端能力扩展与接口定义 (Backend Foundation)**

**目标**: 在不触及任何前端 UI 的情况下，对后端进行扩展，使其能够支持结构化的 Agent 执行流程和事件。这个阶段的重点是**“能力的准备”**和**“契约的定义”**。

#### **任务列表:**

1.  **定义 Agent 元数据结构**:
    *   在 `common/types.ts` 或新文件中，定义 `AgentDefinition` 接口。
    *   该接口应包含 `id`, `name`, `description`, `steps` (一个数组，每个 step 包含 `name`, `description`, `promptFiles`) 和 `parameters` (一个数组，定义所需的用户输入)。
    *   为现有的三个 Agent（项目文档、模块-直接、模块-摘要）创建对应的元数据定义文件（可以是 `.ts` 或 `.json` 文件）。

2.  **扩展 `AgentLogger` 接口**:
    *   在 `extension/services/logging.ts` 中，为 `AgentLogger` 接口添加新的方法以支持结构化日志：
        ```typescript
        interface AgentLogger {
          // ... (保留现有方法)
          // 新增方法
          onPlanGenerated(plan: AgentPlan): void; // 发送规划
          onStepStart(step: StepExecution): void; // 步骤开始
          onStepUpdate(update: StepUpdate): void; // 步骤更新 (如输入/输出)
          onStepEnd(result: StepResult): void;   // 步骤结束
          onStreamChunk(chunk: StreamChunk): void; // LLM流式块
          onAgentEnd(result: AgentResult): void;   // Agent整体结束
        }
        ```
    *   同时定义 `AgentPlan`, `StepExecution` 等相关的类型。

3.  **重构核心 Agent 逻辑 (`Orchestrator` & `Executors`)**:
    *   修改 `ProjectDocumentationOrchestrator`, `ToolChainExecutor`, `MapReduceExecutor` 的 `run` 方法。
    *   将原有的 `logger.info(...)` 调用替换为新的结构化事件调用，如 `logger.onStepStart(...)`, `logger.onStepUpdate(...)` 等。
    *   **关键点**: 这项工作需要非常细致，确保每一个关键动作（如工具调用、LLM 请求、文件写入）都通过 `AgentLogger` 发出事件。
    *   并行任务（如 Map-Reduce）需要为每个并行的子任务发出独立的 `onStepStart`/`onStepEnd` 事件，并携带唯一的 `taskId`。

4.  **创建 `HeadlessLogger` 用于测试**:
    *   在 `extension/services/logging.ts` (或测试目录下) 创建一个新的 `HeadlessLogger` 类，实现 `AgentLogger` 接口。
    *   这个 Logger 的实现非常简单：它只是将接收到的所有结构化事件推送（push）到一个内部的事件数组中。
    *   这将用于在没有 UI 的情况下，验证 Agent 重构后是否能正确地发射事件序列。

5.  **改造 `AgentService`**:
    *   创建新的入口方法 `prepareAndRunAgent(agentId: string, userInput: string, logger: AgentLogger)`。
    *   这个方法会加载 Agent 元数据，解析 `userInput`，然后调用重构后的 Agent `run` 方法。

#### **验收标准:**

*   ✅ 能够通过单元测试或一个临时的测试命令，调用 `prepareAndRunAgent` (传入 `HeadlessLogger`) 来执行任一 Agent。
*   ✅ 执行完毕后，检查 `HeadlessLogger` 内部的事件数组，其内容和顺序必须与预期的 Agent 执行流程完全一致。
*   ✅ **不破坏现有功能**: 运行旧的 `CodeWiki: Generate Project Documentation` 命令，其在 VS Code Output Channel 中的输出应与修改前基本保持一致（因为 `VscodeOutputChannelLogger` 仍然使用旧的 `info`, `error` 方法，而这些方法在重构中被保留了）。

---

### **阶段二：前端交互实现与模拟 (Frontend Prototyping)**

**目标**: 在 Webview 端独立开发完整的用户交互界面，包括 `@` 命令、规划视图和执行视图。在这一阶段，所有与后端的通信都通过**模拟数据 (mock data)** 进行，以实现前后端并行开发。

#### **任务列表:**

1.  **`ChatView` UI 增强**:
    *   实现 `@` 命令的浮动菜单 UI。
    *   实现将选中的 Agent 命令作为“Pill”插入到输入框中。

2.  **创建 `AgentRunBlock` 组件**:
    *   在 `webview/components/` 目录下创建 `AgentRunBlock.ts`。
    *   实现该组件的内部状态管理 (`planning`, `executing`, `done` 等)。
    *   实现 `renderPlanningView()` 方法，它能根据传入的模拟 `AgentPlan` 数据渲染出规划视图（包含步骤卡片、提示词卡片、参数输入框）。
    *   实现 `renderExecutingView()` 方法，它能根据模拟的 `StepExecution` 日志数据渲染出动态的执行视图（包含可折叠的步骤、状态图标、输入/输出卡片）。

3.  **实现前端消息处理器与模拟后端**:
    *   在 `App.ts` 或 `ChatView.ts` 中，创建一个临时的 `mockBackendHandler` 函数。
    *   当用户发送 `@` 命令时，不发送 `postMessage`，而是调用 `mockBackendHandler`。
    *   `mockBackendHandler` 会：
        1.  立即在聊天区创建一个 `AgentRunBlock` 实例。
        2.  向 `AgentRunBlock` 传入一个预先定义好的、模拟的 `AgentPlan` JSON 对象，使其渲染出规划视图。
        3.  模拟参数验证的过程。
    *   当用户在 `AgentRunBlock` 中点击“开始执行”时：
        1.  `mockBackendHandler` 会使用 `setInterval` 或 `setTimeout` 来**模拟**后端事件流。
        2.  它会按时间间隔，依次调用 `AgentRunBlock` 的公共方法（如 `updateStep`, `appendStreamChunk` 等），传入模拟的 `StepUpdate`, `StreamChunk` 数据。

4.  **UI 细化与动效**:
    *   完善所有卡片（步骤、提示词、文件、LLM 请求/响应）的 CSS 样式。
    *   为步骤的折叠/展开、LLM 响应的流式出现等添加平滑的 CSS 过渡效果。

#### **验收标准:**

*   ✅ 在聊天框输入 `@` 能正常弹出并选择 Agent。
*   ✅ 选择 Agent 并回车后，能立即看到一个**完整**的、由模拟数据生成的**规划视图**。
*   ✅ 点击规划视图中的“开始执行”按钮后，视图能切换到**执行视图**，并能**流畅地、动态地**展示一个完整的、由 `setInterval` 模拟的 Agent 执行过程。
*   ✅ 所有 UI 元素的交互（点击提示词卡片、展开/折叠步骤、点击文件卡片）都已实现，即使它们只是在控制台打印日志。
*   ✅ 在此阶段，所有功能**完全不依赖**于 VS Code 扩展后端的任何新接口。

---

### **阶段三：前后端联调与整合 (Integration & Polish)**

**目标**: 将前两个阶段的成果连接起来，用真实的后端事件驱动前端 UI，并进行最终的打磨和测试。

#### **任务列表:**

1.  **定义前后端通信契约**:
    *   在 `common/types.ts` 中正式定义所有 `agent:*` 相关的 `PostMessage` 命令和载荷（payload）的类型。这些类型定义在阶段一和阶段二中已经基本成型。

2.  **实现 `WebviewLogger`**:
    *   在 `extension/services/logging.ts` 中，创建 `WebviewLogger` 类。
    *   实现 `AgentLogger` 接口的所有新方法。每个方法的实现就是向其持有的 `webview` 实例 `postMessage` 一个符合契约的结构化事件。

3.  **连接 `AgentService` 与 Webview**:
    *   在 `CodeWikiViewProvider.ts` 中，实现对 `agent:start`, `agent:execute`, `agent:cancel`, `agent:openFile` 等新命令的处理逻辑。
    *   这些处理逻辑会调用 `AgentService` 的相应方法，并将 `WebviewLogger` 实例传入。

4.  **前端改造：移除模拟后端**:
    *   在 `App.ts` 和 `ChatView.ts` 中，移除 `mockBackendHandler`。
    *   将所有用户操作（如发送 `@` 命令、点击“开始执行”）转换为真实的 `vscode.postMessage`调用。
    *   在 `window.addEventListener('message', ...)` 中，添加对所有新的 `agent:*` 消息的处理逻辑。这些逻辑会调用 `AgentRunBlock` 的相应方法来更新其 UI。

5.  **端到端测试与打磨**:
    *   对所有三种 Agent 进行完整的端到端测试，确保从触发到执行完成的整个流程在真实环境下是流畅和正确的。
    *   特别关注并行任务（Map-Reduce）的 UI 更新是否及时准确。
    *   根据实际效果微调 UI/UX，例如调整流式输出的速度感、卡片展开/折叠的动画效果等。
    *   处理所有边缘情况，如 Agent 执行失败、用户中途取消等。

#### **验收标准:**

*   ✅ 用户在 Webview 中选择并执行任何一个 Agent，`AgentRunBlock` 能够由**真实的后端事件驱动**，完整、正确地展示规划和执行的全过程。
*   ✅ 点击提示词卡片能够在新标签页中打开正确的文件。
*   ✅ 点击执行过程中生成的 `.md` 文件卡片，能够打开正确的临时文档。
*   ✅ 用户中途点击取消，Agent 后端能正确中止，前端 UI 也能正确更新为“已取消”状态。
*   ✅ 旧的 `CodeWiki: Generate Project Documentation` 命令功能完好无损。
*   ✅ 最终功能符合产品需求文档中描述的所有 UI/UX 细节。


继续增强UI UX体验：
1、规划中的弹出卡片出来要有动画，而不是突然出现
2、第一阶段规划的卡片要保留，输入参数后，像是当前项目路径是xxx，下一步进行分析项目结构，整体过程要流畅，要能体现agent的整体过程，每个细节要注意；当前太粗太跳跃，用户不容易理解
3、进行中的转圈要用loading的动画，当前就一个静态的半圈，没有动画不好看；要让用户时时刻刻知道你在努力干活；这个动画资源如果你没有，你给我提示，要什么格式的资源，我去给你找；