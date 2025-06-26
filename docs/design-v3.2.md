当前存在的问题
1、卡片不能滚动到最新
2、direct和MapReduce的卡片内容不完整
3、MapReduce的token统计是空

MapReduce的卡片内容不完整
Step1卡片没显示。
预期 Step1 准备: 文件分批
应当描述当前模块token是多少，大于阈值，分了几批文件
显示内容包括，
当前扫描文件夹：xxx
扫描到 N 个文件
模块总 Token 数: XXXXX (超过阈值 YYYYY)" (如果超过)。
已分批为 M 个批次

Step2卡片有，内容空。预期 Step2 Map阶段: 并行分析，
应当以子卡片形式，展示每次的LLM request 和 llm返回的结果
每个子步骤（如 "分析批次 1/M"）应有自己的状态（running, completed, failed）。
每个子步骤内部可以折叠/展开，显示其对应的 LLM 请求（type: 'llm-request'）和 LLM 响应（type: 'output'，这里指批次摘要）。

当前ProjectDocumentationOrchestrator是调用两个子agent的。运行是嵌套，前端输出也应该包含清楚子流程。当前后端事件 和 前端流程如何抽象成标准的langchain agent流程，使得前端的agentblock不用太多adhoc的适配就能支持呢？给出设计思路，全程用中文交流