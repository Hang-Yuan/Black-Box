import type { Locale } from '../stores/settingsStore';

export interface ChangelogCategory {
  label: Record<Locale, string>;
  items: Record<Locale, string[]>;
}

export interface ChangelogEntry {
  version: string;
  date: string;
  highlights: Record<Locale, string[]>;
  categories?: ChangelogCategory[];
}

/**
 * Changelog entries for the "What's New" modal.
 * Only include versions with user-facing changes worth highlighting.
 * Ordered newest first. Update this when releasing a new version.
 */
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.14.51',
    date: '2026-09-11',
    highlights: {
      zh: [
        '保持 macOS 后台与被遮挡窗口的 WebView 活跃，避免 WebKit 挂起并释放渲染图层后出现整窗黑屏',
      ],
      en: [
        'Keeps the macOS WebView active while its window is backgrounded or occluded, preventing full-window black screens after WebKit suspends and discards render layers',
      ],
    },
  },
  {
    version: '0.14.50',
    date: '2026-09-11',
    highlights: {
      zh: [
        '排程终答使用原生 end_turn 边界保持可见，并在后台进程结束后继续同步收尾；任务中心自动展开最新汇报，区分“已完成 · 待裁决”和真实失败',
        '完成探针可核对 Black Box 私有数据目录中的 commit、manifest 与释放锁，已补完的历史失败会自动恢复为完成状态',
      ],
      en: [
        'Keeps scheduled final reports visible through native end-turn boundaries and a bounded post-run transcript sync; Scheduled opens the latest report and distinguishes completed decisions from failures',
        'Verifies commit, manifest, and released-lock evidence in Black Box private data before reconciling completed historical failures',
      ],
    },
  },
  {
    version: '0.14.49',
    date: '2026-09-09',
    highlights: {
      zh: [
        '拦截模型无可见终答却返回成功的回合，在原会话内有限续跑；上下文压力过高时先自动压缩，排程任务也会保留收据链并完成最多三次恢复',
      ],
      en: [
        'Intercepts successful turns with no visible final response and retries them within the original thread; compacts first under high context pressure and gives scheduled runs up to three receipt-preserving recovery attempts',
      ],
    },
  },
  {
    version: '0.14.47',
    date: '2026-09-08',
    highlights: {
      zh: [
        '大型工作区文件树改为按目录逐层加载，关闭文件面板后停止扫描与监听，避免后台文件刷新耗尽 WebContent 内存',
      ],
      en: [
        'Loads large workspace trees one directory at a time and stops scanning or watching while Files is closed, preventing background refreshes from exhausting WebContent memory',
      ],
    },
  },
  {
    version: '0.14.46',
    date: '2026-08-30',
    highlights: {
      zh: [
        '工具行优先展示语义描述，原始执行命令缩为短预览并保留在展开详情中',
      ],
      en: [
        'Prioritizes semantic tool descriptions, reducing raw commands to short previews while preserving their full expandable details',
      ],
    },
  },
  {
    version: '0.14.45',
    date: '2026-08-30',
    highlights: {
      zh: [
        '工具调用标题统一为“原始工具名[中文类型]：英文描述（确定性中文）”，完整命令继续保留在展开详情中',
      ],
      en: [
        'Formats tool titles as “raw tool name[localized type]: English description (verified Chinese)” while keeping exact commands in expandable details',
      ],
    },
  },
  {
    version: '0.14.44',
    date: '2026-08-30',
    highlights: {
      zh: [
        '工具调用标题固定显示“工具类型：英文原始描述”；仅在命中人工确认词条时追加中文括注，未知描述不猜译',
      ],
      en: [
        'Formats tool titles as “tool type: original English description” and appends Chinese only for exact human-reviewed phrases, without guessing unknown text',
      ],
    },
  },
  {
    version: '0.14.43',
    date: '2026-08-30',
    highlights: {
      zh: [
        '侧栏会话时间改用最后一条可见会话事件，不再被后台元数据写入和文件修改时间推迟',
        '终端工具调用优先显示“读取文件”“执行测试”等语义描述，分组摘要可直接看懂，完整 Bash 命令与结果仍可展开查看',
        'Debug 运行时启动改为 fail-closed：缺少隔离 Profile、命中真实 HOME 或数据目录逃逸时会在加载会话前直接拒绝启动',
      ],
      en: [
        'Uses the last visible conversation event for sidebar activity time so background metadata writes and file mtimes can no longer move a session forward',
        'Shows human-readable actions such as reading files and running tests for terminal tool calls and grouped summaries while keeping exact Bash commands and results expandable',
        'Makes Debug startup fail closed before session loading when the isolated profile is missing, HOME resolves to the production account, or runtime data escapes its profile',
      ],
    },
  },
  {
    version: '0.14.41',
    date: '2026-08-16',
    highlights: {
      zh: [
        '收紧已安排任务最近运行的状态与时间间距；日期继续整列右对齐，未读标记只在实际出现时占位',
      ],
      en: [
        'Tightens status-to-time spacing in Scheduled Recent Runs while keeping timestamps right-aligned and reserving unread space only when present',
      ],
    },
  },
  {
    version: '0.14.40',
    date: '2026-08-16',
    highlights: {
      zh: [
        '已安排任务的最近运行列表固定对齐状态、未读标记与时间，长摘要不会再把状态徽章挤成竖排',
      ],
      en: [
        'Aligns status, unread, and timestamp slots in Recent Runs so long summaries can no longer squeeze badges into vertical text',
      ],
    },
  },
  {
    version: '0.14.39',
    date: '2026-08-16',
    highlights: {
      zh: [
        '已安排任务支持持久化完成凭证：任务已经提交、尾部恢复进程异常时会自动校正为“已恢复”，并保留原报错、正文与工具轨迹；启动和打开任务中心时也会补核验',
      ],
      en: [
        'Adds durable completion receipts for scheduled work: committed tasks whose recovery tail fails are automatically reconciled as recovered while preserving the original error, output, and tool trace, including startup and Task Center backfill checks',
      ],
    },
  },
  {
    version: '0.14.38',
    date: '2026-08-15',
    highlights: {
      zh: [
        '长终端命令的展开详情改为有高度上限的滚动框，避免 heredoc 和脚本正文无限撑高主对话',
      ],
      en: [
        'Constrains expanded long terminal commands to a bounded scrollable frame so heredocs and script bodies no longer stretch the conversation',
      ],
    },
  },
  {
    version: '0.14.37',
    date: '2026-08-15',
    highlights: {
      zh: [
        '恢复主智能体 thinking：生成时实时显示，完成、中断和重载后保留为默认折叠的小字行；同一 SDK 消息会稳定去重，子智能体细节仍留在右侧进程栏',
      ],
      en: [
        'Restores lead-agent thinking as live output that persists after completion, interruption, and reload in compact default-collapsed rows, with stable SDK-message deduplication and subagent detail kept in the Process panel',
      ],
    },
  },
  {
    version: '0.14.36',
    date: '2026-08-15',
    highlights: {
      zh: [
        '失败的已安排任务可以按原计划时间补跑；补跑成功后原记录显示“补跑完成”，同时保留原报错、工具轨迹与独立补跑审计记录',
      ],
      en: [
        'Adds auditable retries for failed scheduled runs: a successful retry marks the original as recovered while preserving its error, tool trace, and separate retry record',
      ],
    },
  },
  {
    version: '0.14.35',
    date: '2026-08-14',
    highlights: {
      zh: [
        '对话双方头像试调至 60px，并同步扩大正文、过程更新和交互卡片的对齐留白',
      ],
      en: [
        'Raises both chat avatars to 60px and expands the aligned gutter for prose, process updates, and interaction cards',
      ],
    },
  },
  {
    version: '0.14.34',
    date: '2026-08-14',
    highlights: {
      zh: [
        '对话双方头像进一步放大至 50px，并同步校准消息正文、过程更新和交互卡片的水平留白',
      ],
      en: [
        'Further enlarges both chat avatars to 50px and recalibrates the horizontal gutter for messages, process updates, and interaction cards',
      ],
    },
  },
  {
    version: '0.14.33',
    date: '2026-08-14',
    highlights: {
      zh: [
        '对话中的用户与助手头像统一放大至 40px，同步调整正文、过程更新和交互卡片的对齐留白',
      ],
      en: [
        'Enlarges both chat avatars to 40px and keeps prose, process updates, and interaction cards aligned to the same gutter',
      ],
    },
  },
  {
    version: '0.14.32',
    date: '2026-08-14',
    highlights: {
      zh: [
        '空闲 Claude 连接采用分层回收：已使用会话保温 4 小时、未发消息的预热会话保温 30 分钟，并最多保留 4 个；归档或删除会话会立即优雅关闭连接',
        '修复进程续接后折叠的过程更新抢占头像位置，最终答复会继续显示助手头像',
      ],
      en: [
        'Adds tiered warm-process cleanup: four hours for used conversations, 30 minutes for unused pre-warms, a four-connection LRU cap, and immediate graceful shutdown on archive or delete',
        'Keeps the assistant avatar on the final answer after reconnecting when folded process updates precede it',
      ],
    },
  },
  {
    version: '0.14.31',
    date: '2026-08-14',
    highlights: {
      zh: [
        '顶部 Agent 恢复为状态与名单下拉菜单，后台数量收进菜单，页面上下不再显示重复横幅',
        '下拉菜单的“查看过程”会打开右侧进程栏、定位并展开对应子智能体；右栏开合保留主对话的当前阅读位置',
      ],
      en: [
        'Restores the top Agent roster popover, moves the running-background count into it, and keeps duplicate page banners removed',
        'View process now opens and focuses the matching subagent in the Process panel while preserving the conversation reading position during panel layout changes',
      ],
    },
  },
  {
    version: '0.14.30',
    date: '2026-08-14',
    highlights: {
      zh: [
        '保留带最新内容预览的“过程更新”折叠组；主 Agent 进度可随时展开，子智能体过程只进入右侧进程栏',
        '顶部 Agent 状态改为唯一进程入口，直接开关右侧进程栏，并移除页面上下重复的后台运行横幅与独立进程图标',
      ],
      en: [
        'Keeps the expandable Process Updates group with a live latest-content preview while forwarded subagent activity stays in the Process panel',
        'Makes the top Agent status the single direct Process-panel toggle and removes duplicate background banners and the separate Process icon',
      ],
    },
  },
  {
    version: '0.14.29',
    date: '2026-08-13',
    highlights: {
      zh: [
        'Black Box 启动的 Claude 进程会关闭官方后台自动检查，由可见的手动维护流程统一持有更新生命周期，避免应用退出后再次出现无人监控的 `claude update`',
      ],
      en: [
        'Disables Claude background update checks for processes launched by Black Box so the visible manual maintenance flow owns the update lifecycle and no unmonitored `claude update` reappears after app exit',
      ],
    },
  },
  {
    version: '0.14.28',
    date: '2026-08-13',
    highlights: {
      zh: [
        'Claude CLI 更新始终显示真实已下载字节；远端总大小探测增加 Range 回退，慢速下载不再看起来像静止的进度条',
      ],
      en: [
        'Always shows real downloaded bytes for Claude CLI updates and adds a Range fallback for remote size discovery so slow transfers no longer look like a frozen progress bar',
      ],
    },
  },
  {
    version: '0.14.27',
    date: '2026-08-13',
    highlights: {
      zh: [
        '历史恢复会过滤 Claude CLI 写入的中断占位记录，停止操作不再留下 `[Request interrupted by user]` 用户气泡',
      ],
      en: [
        'Filters Claude CLI interruption placeholders during history restoration so stopping a turn no longer leaves a `[Request interrupted by user]` bubble in the conversation',
      ],
    },
  },
  {
    version: '0.14.26',
    date: '2026-08-13',
    highlights: {
      zh: [
        '显式退出会等待正在进行的 CLI 维护到达受限终态，避免官方更新器脱离 Black Box 成为无法监控的后台孤儿进程',
      ],
      en: [
        'Defers explicit app exit until in-flight CLI maintenance reaches its bounded terminal state so the official updater cannot outlive Black Box as an unobservable orphan process',
      ],
    },
  },
  {
    version: '0.14.25',
    date: '2026-08-13',
    highlights: {
      zh: [
        'Claude CLI 官方更新现在显示真实下载字节与百分比，停滞会明确提示；重新打开设置会接回同一更新，重复点击不再误报为对话占用',
        'macOS 菜单栏改用透明单色 Black Box 模板图标，不再把应用图标的不透明背景渲染成白色方块',
      ],
      en: [
        'Reports real downloaded bytes and percentage for the official Claude CLI updater, identifies stalled transfers, reconnects remounted Settings to the same update, and no longer mislabels a duplicate request as a busy conversation',
        'Uses a transparent monochrome Black Box template in the macOS menu bar instead of rendering the opaque application-icon background as a white square',
      ],
    },
  },
  {
    version: '0.14.24',
    date: '2026-08-13',
    highlights: {
      zh: [
        '中断后续写使用的内部控制提示保持为运行时私有载荷；应用重启、历史恢复和导出只显示用户原话，同时统一过滤 Claude CLI 的无正文占位语',
      ],
      en: [
        'Keeps interrupted-turn recovery instructions private to the runtime so restart, history, and export project only the user-authored message, with one shared filter for Claude CLI no-content placeholders',
      ],
    },
  },
  {
    version: '0.14.23',
    date: '2026-08-13',
    highlights: {
      zh: [
        '应用重启或从磁盘重新载入会话时，缺少终态通知的历史后台 Agent 会明确标记为已中断，不再制造“仍在运行”的假状态；过程记录仍保留在右侧进程栏',
      ],
      en: [
        'Marks unresolved historical background agents as interrupted after app restart or disk hydration instead of reporting false live work, while retaining their process history in the Process panel',
      ],
    },
  },
  {
    version: '0.14.22',
    date: '2026-08-13',
    highlights: {
      zh: [
        '主对话只保留主 Agent 的综合答复；阶段性说明折叠为过程更新，子智能体的显式进度、工具轨迹和结果进入右侧进程栏并可按需展开',
        '主回复结束后若后台 Agent 仍在运行，会持续显示真实状态和数量，并可直接进入进程栏查看；完整任务通知协议不再泄漏到聊天正文',
        '右侧进程/文件页签、面板宽度、打开文件、编辑缓冲与文件树状态均按会话独立保存，切换会话不再相互串联',
        '侧栏会话支持通过六点拖柄在分组内排序、跨分组移动以及拖回未归类，同时保留点击、改名、右键和多选交互',
      ],
      en: [
        'Keeps the primary transcript focused on the lead agent synthesis, folds lead progress into Process Updates, and routes explicit subagent progress, tool traces, and results to an optional Process panel',
        'Continues to show accurate background-agent state and counts after the lead reply finishes, opens the Process panel directly, and removes raw task-notification protocol blocks from chat',
        'Persists the Process/Files tab, panel width, open document, edit buffer, and file-tree state independently for every conversation so task switches cannot leak view state',
        'Adds a dedicated six-dot drag handle for reordering conversations within groups, moving them across groups, and returning them to Uncategorized while preserving click, rename, context-menu, and multiselect behavior',
      ],
    },
  },
  {
    version: '0.14.21',
    date: '2026-08-10',
    highlights: {
      zh: [
        '排程在后台 Agent 结束后会回到同一会话完成一次终态收束，并持续显示仍在运行的排程、工具与子智能体；缺失控制请求的权限卡可自动解除，不再锁死对话',
        '同一逻辑回复按 Claude message ID 归并，内部思考只保留实时状态且不再作为历史正文重复显示；分支与普通会话统一恢复工具、子代与失败重试状态',
        '逐会话恢复文件预览、编辑缓冲、文件树与滚动位置；并排对照首次打开定位到共同对话轮，代码长行自动换行，项目组展开与收起状态跨重启保留',
        '默认 API、主模型和子模型可独立选择；Goal 活跃态保持可见；macOS 关闭窗口后继续在后台运行，并可从菜单栏重新打开，只有显式退出才停止运行',
      ],
      en: [
        'Returns to the same scheduled conversation for one bounded terminal synthesis after background agents finish, keeps scheduled work, tools, and subagents visibly active, and automatically releases permission cards that never receive a control request',
        'Correlates one logical response by its Claude message ID so internal thinking remains transient instead of replaying as duplicate history, with consistent tool, subagent, and retry recovery across branched and ordinary conversations',
        'Restores file previews, edit buffers, explorer state, and scroll position per conversation; aligns comparison views to the shared turn on open, wraps long code lines, and preserves expanded and collapsed project groups across restarts',
        'Lets users choose the default API, primary model, and subagent model independently, keeps active Goal state visible, and makes the macOS close button hide the window while menu-bar access and background work remain available until explicit Quit',
      ],
    },
  },
  {
    version: '0.14.20',
    date: '2026-08-01',
    highlights: {
      zh: [
        '创建排程前会先读取目标 Skill、核对全部写入位置，并把最小共同项目根与 Black Box 数据写目录写入任务定义；保存后自动做一次可清理的隔离 smoke',
        '排程中出现锁、写入或工具失败时，即使 Claude 进程正常退出也会记录为 FAILED；成功回执与失败回执均作为调度器控制记录处理，不再污染可见报告',
        'Scheduled smoke 同时验证项目目录与受控数据目录，结束后删除测试任务、测试会话、历史索引和临时输出，并机械检查没有会话残留',
      ],
      en: [
        'Inspects the target skill and every write location before creating a schedule, then records the smallest common project root and controlled Black Box data directories and performs a disposable isolated smoke after saving',
        'Records lock, write, and tool failures as FAILED even when Claude exits normally, while treating both success and failure receipts as scheduler control records instead of visible report content',
        'Validates both project and controlled data-directory writes in Scheduled smoke runs, then deletes test tasks, conversations, history indexes, and temporary outputs and mechanically checks for conversation residue',
      ],
    },
  },
  {
    version: '0.14.19',
    date: '2026-07-31',
    highlights: {
      zh: [
        '每条对话独立记住 Provider 钥匙与模型；鼠标、快捷键和内部切换都会先恢复目标会话偏好，草稿晋升、Provider 删除和快速切换也保持一致',
        '聊天阅读点、文件预览、编辑缓冲、文件树展开与文档滚动统一通过逐会话事务保存；侧栏时间按本地自然日显示，昨天明确标注“昨天 HH:mm”',
        'Workflow 默认提供自然语言自动编排：AI 先判断直接任务、分阶段工作、持久 Goal 或周期请求，再使用当前 Claude runtime 真实提供的能力；周期任务创建前必须回显定义并确认',
        '右侧 Activity 或文件栏打开时，顶栏依据真实剩余宽度响应；Workflow、Loop、Goal 的箭头菜单均可进入模式，会话运行中也能通过 Steer 或 Queue 追加任务',
        'Scheduled 运行补齐 automation/run 身份、只读查询与受控写目录合同；当前任务定义保持空列表，任何新排程都需经对话确认',
      ],
      en: [
        'Remembers the provider route and model independently for every conversation, restoring the target preference before mouse, keyboard, or internal switches while preserving draft promotion, provider deletion, and rapid-switch consistency',
        'Saves chat position, file preview, edit buffers, expanded file-tree state, and document scroll through one per-conversation transaction, while sidebar timestamps now follow local calendar days and label yesterday explicitly',
        'Makes natural-language automatic orchestration the default Workflow path: the agent first classifies a direct task, staged workflow, durable Goal, or recurring request, then uses only capabilities exposed by the active Claude runtime and confirms every recurring definition before creation',
        'Keeps full header labels while the Activity or file panel is open whenever real space remains; Workflow, Loop, and Goal dropdowns can enter their modes, including during an active turn through Steer or Queue',
        'Adds automation/run identity, read-only queries, and controlled write-directory contracts to Scheduled execution while keeping the current definition list empty until a new schedule is confirmed in conversation',
      ],
    },
  },
  {
    version: '0.14.18',
    date: '2026-07-28',
    highlights: {
      zh: [
        '系统 Claude 环境会完整保留 ~/.claude 中的原生 SessionStart 与 UserPromptSubmit hooks，Black Box 只追加辅助模型路由，不再覆盖身份与时间上下文',
        '隔离环境与系统环境会双向补齐 Black Box 已跟踪但目标侧缺失的会话，切换环境后历史对话不再消失；已有文件永不覆盖、移动或删除',
        '交互会话与自动任务共用当前系统环境的原生 hooks，避免定时运行与手动对话出现身份、时间上下文或登录状态分叉',
        '切换会话后恢复聊天阅读位置、已打开文件、预览模式与文件滚动位置，返回长对话或文档时保持离开前的阅读点',
      ],
      en: [
        'Preserves native SessionStart and UserPromptSubmit hooks from ~/.claude in the system Claude environment, while Black Box adds only auxiliary-model routing instead of replacing identity and time context',
        'Synchronizes missing Black Box-owned conversations in both directions between isolated and system environments without overwriting, moving, or deleting existing state',
        'Uses the active system environment’s native hooks for both interactive sessions and automations so identity, time context, and login state do not diverge',
        'Restores chat reading position, open file, preview mode, and file scroll position when returning to a conversation',
      ],
    },
  },
  {
    version: '0.14.16',
    date: '2026-07-28',
    highlights: {
      zh: [
        '修复切换 API 或模型后恢复会话时的上下文降级与重复问候，失败的恢复不再静默创建空白会话',
        '辅助模型始终使用 Claude Code 原生档位，并由当前 Provider 的四档映射解析，避免 GLM 等兼容通道因缺少 Haiku 映射而中断',
        '新增 Black Box 私有身份启动链：显式导入的身份快照会在新建、恢复、清空、压缩和分支会话启动时按顺序注入，并带完整性标记与失败兜底',
        '身份文件、启动同步 Skill、Hooks 与运行状态全部留在 Black Box 私有 Claude 根中，不读取或共享 TOKENICODE 与 ~/.claude 的配置',
      ],
      en: [
        'Fixes context degradation and repeated greetings after API or model switches, while failed resumes no longer fall through to a blank conversation',
        'Keeps auxiliary routing on native Claude Code tiers and resolves them through the active provider’s four-slot mapping, preventing compatible providers such as GLM from failing on a missing Haiku mapping',
        'Adds an explicit private identity bootstrap whose snapshots load in order for new, resumed, cleared, compacted, and forked sessions with an integrity marker and fallback',
        'Keeps identity files, the startup sync skill, hooks, and runtime state inside Black Box’s private Claude root without reading or sharing TOKENICODE or ~/.claude configuration',
      ],
    },
  },
  {
    version: '0.14.14',
    date: '2026-07-26',
    highlights: {
      zh: [
        '移除 Black Box 自建的 Plan 与网页检索 MCP 替代层；WebSearch、WebFetch、Task/Plan 状态全部直接来自当前 Claude Code 运行时',
        'Goal、Loop 与 Workflow 只在 Claude Code 实际公布对应命令或工具时启用，Black Box 不再维护另一套 Goal 生命周期、预算或自动编排语义',
        '文件引用会先在完整工作区中消歧再打开；目录结构文本、截断结果和重名文件不会再被误当成可预览文件',
        '运行时没有公布 Grep 或 Glob 时保持原样，不注入、不模拟，也不通过 MCP 强行补回',
      ],
      en: [
        'Removes Black Box replacements for Plan and web retrieval; WebSearch, WebFetch, and Task/Plan state now come directly from the active Claude Code runtime',
        'Enables Goal, Loop, and Workflow only when Claude Code advertises the matching command or tool, without a second Goal lifecycle, budget, or auto-orchestration contract',
        'Resolves file references against the complete workspace before opening them, while rejecting directory-tree text, truncated results, and ambiguous duplicate names',
        'Leaves Grep and Glob absent when the runtime does not advertise them instead of injecting, simulating, or restoring them through MCP',
      ],
    },
  },
  {
    version: '0.14.13',
    date: '2026-07-26',
    highlights: {
      zh: [
        'Black Box 现在使用独立的 Claude 配置根与会话存储；首次启动只迁移已由 Black Box 跟踪的历史会话，不再与 TOKENICODE 共用运行状态',
        '恢复 Claude Code 原生 WebSearch、WebFetch、Read 与 Agent 调度，辅助模型只使用 CLI 支持的档位别名，并按运行时实际工具清单展示能力',
        '修复图片工具结果在 OpenAI/Gemini 兼容通道中的保真传递、文件路径预览、结构树误识别和长任务组菜单的视口自适应交互',
        'Provider 凭据改为 Black Box 私有、仅当前用户可读的本地配置，避免 macOS 钥匙串重复授权弹窗',
      ],
      en: [
        'Black Box now uses an independent Claude configuration root and session store; first launch migrates only conversations already tracked by Black Box instead of sharing runtime state with TOKENICODE',
        'Restores native Claude Code WebSearch, WebFetch, Read, and Agent routing, constrains auxiliary models to CLI-supported tiers, and reflects the runtime tool inventory exactly',
        'Preserves image tool results through OpenAI/Gemini-compatible providers and fixes file-path previews, structure-tree misclassification, and viewport-aware task-group menus',
        'Stores provider credentials in a private owner-only Black Box configuration file to avoid recurring macOS Keychain authorization prompts',
      ],
    },
  },
  {
    version: '0.14.12',
    date: '2026-07-23',
    highlights: {
      zh: [
        '补回前端 Home 目录桥接对应的原生命令，技能创建、波浪线路径解析和历史会话路径显示不再因命令缺失静默失败',
        '与上游 v0.11.0 后续维护历史完成兼容收口，同时保留 Black Box 新的作用域感知 MCP 管理器、发布链和默认关闭的下一代架构',
      ],
      en: [
        'Restores the native command behind the frontend home-directory bridge so skill creation, tilde-path resolution, and historical-session path display no longer fail on a missing command',
        'Reconciles the post-v0.11.0 upstream maintenance history while preserving Black Box’s scope-aware MCP manager, release pipeline, and default-disabled next-generation architecture',
      ],
    },
  },
  {
    version: '0.14.11',
    date: '2026-07-23',
    highlights: {
      zh: [
        '随应用固化下一代 Runtime、SQLite Memory、RAG 授权、PetPack 与托管模型合同的隔离架构；所有实验能力继续默认关闭，不接入现役记忆、真实模型请求或支付',
        'Memory 隔离演练补充授权生命周期、日志时间单调性与系统时钟回拨防护，失败验证不会消耗单次授权',
        '每次 Memory operator 日志追加都会在提交前复验完整语义链、授权绑定与 authority state，降低损坏记录进入恢复链的风险',
      ],
      en: [
        'Ships the isolated next-generation Runtime, SQLite Memory, RAG consent, PetPack, and managed-provider contracts with every experimental capability still disabled by default and disconnected from live memory, model requests, and billing',
        'Hardens isolated Memory rehearsals with bounded authorization lifetimes, journal-monotonic timestamps, and system-clock rollback protection without consuming a one-shot authorization on failed validation',
        'Revalidates the full Memory operator semantic chain, authorization binding, and authority state before every journal append is committed',
      ],
    },
  },
  {
    version: '0.14.10',
    date: '2026-07-18',
    highlights: {
      zh: [
        '旧客户端会话继续以只读方式增量导入，但兼容磁盘标识改为仅在运行时解码，Black Box 源码、日志、界面和正式二进制均不再携带旧产品名',
        '修复 macOS 自带 Bash 在目标 DMG 目录为空时触发未绑定数组错误，空目录与已有安装包两种本地构建路径都可稳定进入完整校验链',
        '九家 Provider 始终保留四个可独立选择和保存的逻辑档位；即使供应商暂时让多档共用同一个上游模型，也不会再被界面去重吞掉',
        '本地 DMG 现在附带不可变来源清单，将安装包哈希绑定到候选源码树和全文件聚合哈希，并明确标注本地 ad-hoc 签名、未公证和不可公开分发的信任边界',
        '候选审计现在强制配置本机私有路径哨兵，Rust 编译来源统一映射为中性相对路径，安装包会拒绝真实用户目录与旧构建伪路径',
        '扩展中心原生验收跟随新的任务模式交互：主按钮只负责切换 Workflow、Loop、Goal，管理按钮单独打开说明；三种浮层、Agent Team 开关和 1280×800 布局全部通过复验',
        '隔离测试清理扩大到 Claude session 元数据与 shell 快照，任何 Black Box 测试会话结束后都会连同索引和运行残留一起清零',
      ],
      en: [
        'Retired-client sessions remain available through read-only incremental import, while compatibility disk identifiers are decoded only at runtime so the old product name is absent from current source, logs, UI, and release binaries',
        'Local macOS packaging now handles an empty target DMG directory under the system Bash as reliably as one containing preserved artifacts, without an unbound-array failure',
        'All nine providers now retain four independently selectable and persistable logical slots, even when a provider temporarily maps multiple slots to the same upstream model',
        'Local DMGs now carry an immutable provenance manifest binding the installer hash to the candidate source tree and aggregate file hash, while explicitly recording ad-hoc signing, no notarization, and the local-only trust boundary',
        'Candidate auditing now requires private-path sentinels, maps Rust provenance to a neutral relative root, and rejects both real user directories and the obsolete synthetic build root from the app bundle',
        'Native extension acceptance now follows the task-mode interaction contract: primary buttons select Workflow, Loop, or Goal while separate manage buttons open explanations; all three popovers, the Agent Team switch, and the 1280×800 layout pass validation',
        'Isolated cleanup now covers Claude session metadata and shell snapshots so every Black Box test conversation leaves with its indexes and runtime residue removed',
      ],
    },
  },
  {
    version: '0.14.8',
    date: '2026-07-18',
    highlights: {
      zh: [
        'Workflow、Loop 与 Goal 主模式切换现在会同步收起所有旧管理浮层，保证顶部始终只有一个任务模式和一层操作界面处于活动状态',
        '隔离 WebView 复验覆盖三种模式交叉切换、主输入框编排提示和 1280×800 布局边界，测试会话与索引在验收后立即清零',
      ],
      en: [
        'Switching the primary Workflow, Loop, or Goal mode now closes every stale management popover so the header keeps exactly one active task mode and one interaction layer',
        'Isolated WebView validation now covers cross-mode switching, main-composer orchestration guidance, and 1280×800 layout bounds, with test conversations and indexes cleared immediately after acceptance',
      ],
    },
  },
  {
    version: '0.14.7',
    date: '2026-07-18',
    highlights: {
      zh: [
        'Workflow 默认进入自动编排：任务只需写在当前主输入框，先展示可见阶段，再按当前 CLI 实际提供的 Workflow、Plan、Task 或 Agent 能力执行；没有真实工具回执时不会伪造运行状态',
        '斜杠命令目录改为运行时权威：Black Box 只保留自己的界面控件，Claude 命令、Skills、Workflows、插件与 MCP 能力随当前 CLI 实时更新，不再被旧静态清单截断或冒充',
        'CLI 更新与重装失败会给出网络、会话占用、已安排任务、SDK 损坏、权限或安装渠道的处理建议，并将完整原始错误保留在可展开技术详情中',
        '修复 Activity 空状态触发的 React 无限更新崩溃，并强化候选审计对已删除旧文件的处理，避免退休文件重新进入新版本候选包',
      ],
      en: [
        'Workflow now defaults to automatic orchestration: author the task only in the current composer, see its stages first, and use only Workflow, Plan, Task, or Agent capabilities actually exposed by the active CLI; no runtime state is fabricated without a real tool receipt',
        'The slash catalogue is now runtime-authoritative: Black Box keeps only its own UI controls while Claude commands, Skills, Workflows, plugins, and MCP capabilities update from the active CLI without stale truncation or synthetic entries',
        'CLI update and reinstall failures now provide actionable network, session, scheduled-task, SDK-runtime, permission, or installation-owner guidance while preserving the full raw error in expandable technical details',
        'An Activity empty-state React update loop is fixed, and candidate auditing now omits intentionally deleted legacy files so retired source cannot re-enter a new release candidate',
      ],
    },
  },
  {
    version: '0.14.5',
    date: '2026-07-18',
    highlights: {
      zh: [
        '任务组、归档、置顶、排序与自定义名称可导出为独立组织包，并在另一台电脑安全合并；组织包不包含对话正文、API 钥匙或 CLI 配置',
        '会话组织元数据升级为统一原子权威层，旧数据自动迁移；跨电脑导入采用本地优先合并并保留删除墓碑，避免旧备份复活已移除状态',
        '桌面伙伴扩展为完整原生悬浮系统：20 个内置形象、自主捏制、六种任务状态、跨桌面置顶、位置恢复与独立关闭控制',
      ],
      en: [
        'Task groups, archives, pins, ordering, and custom names can now be exported as a portable organization bundle and safely merged on another Mac without conversation content, API keys, or CLI configuration',
        'Conversation organization now uses one atomic metadata authority with automatic migration; local-first imports honor deletion tombstones so stale backups cannot resurrect removed state',
        'The desktop companion is now a complete native floating system with 20 built-in characters, a custom maker, six task states, cross-space pinning, position recovery, and independent close controls',
      ],
    },
  },
  {
    version: '0.14.4',
    date: '2026-07-15',
    highlights: {
      zh: [
        'Goal、Workflow、Loop、Steer 与 Queue 统一回到主对话输入框，模式切换、目标状态、长链路进度和具体子智能体身份可直接查看',
        '任务组、排序、置顶与归档进入 Black Box 原子元数据层；退休客户端历史可只读增量导入，归档按原任务组默认折叠且不显示累计数字',
        'Hook 新建与完整扫描、内置本机时间上下文、最新斜杠命令、文件行号精确跳转、Scheduled 未读收口、CLI 更新红点与沙漏桌面伙伴同步上线',
      ],
      en: [
        'Goal, Workflow, Loop, Steer, and Queue now live in the main composer, with visible mode state, durable goals, long-running progress, and concrete subagent identity',
        'Task groups, ordering, pins, and archives now use Black Box’s atomic metadata authority; retired-client history imports incrementally and read-only, while archives retain collapsed groups without lifetime counters',
        'Hook creation and complete discovery, built-in local time context, current slash commands, exact file-line navigation, Scheduled unread settlement, CLI update indicators, and the hourglass desktop companion now ship together',
      ],
    },
  },
  {
    version: '0.14.3',
    date: '2026-07-15',
    highlights: {
      zh: [
        '应用内 CLI 更新会识别回合已完成但仍保持连接的对话，经确认后安全落盘并保留续接信息',
        '正在生成、重连、等待用户回答及正在运行的已安排任务不会被更新器强行终止',
        'CLI 更新期间暂停新对话与新定时执行，失败原因完整显示并提供中文处理提示',
      ],
      en: [
        'In-app CLI updates now recognize completed conversations that still keep a warm connection, safely flush them after confirmation, and preserve resume state',
        'Generating, reconnecting, user-awaiting, and running scheduled work is never force-stopped by the updater',
        'New conversations and scheduled launches pause during CLI maintenance, while update failures remain fully visible with actionable guidance',
      ],
    },
  },
  {
    version: '0.14.2',
    date: '2026-07-15',
    highlights: {
      zh: [
        '九家 Provider 统一提供具体的主对话模型与辅助任务模型选择，Agent、Agent Teams 与网页检索强制使用轻量辅助模型',
        '扩展中心、独立 Scheduled 页面、Activity 长链进度与三项核心设置完成统一信息架构',
        'AskUserQuestion、会话级权限、运行中 Steer、历史分支与并排对照形成完整任务交互链',
      ],
      en: [
        'Nine providers now expose concrete primary and auxiliary model selectors, with Agents, Agent Teams, and web retrieval enforced onto the lighter auxiliary model',
        'A unified information architecture now covers Extension Center, the standalone Scheduled page, long-running Activity progress, and three focused Settings sections',
        'AskUserQuestion, session-scoped permissions, live Steer, historical forks, and side-by-side comparison complete the task interaction flow',
      ],
    },
    categories: [
      {
        label: { zh: '模型与 Provider', en: 'Models and providers' },
        items: {
          zh: [
            '固定 Claude、OpenAI、Gemini、DeepSeek、GLM、豆包、千问、MiniMax 与 Kimi 九家目录，并按各家实际模型直接展示可选档位',
            '主对话与辅助任务在会话启动时冻结；缺失辅助模型时明确失败，不会静默回退到昂贵主模型',
            'API 钥匙/中转站可从顶栏快速切换，凭据继续保存在系统凭据层，界面只显示脱敏信息',
          ],
          en: [
            'A fixed catalog covers Claude, OpenAI, Gemini, DeepSeek, GLM, Doubao, Qwen, MiniMax, and Kimi with provider-specific concrete model choices',
            'Primary and auxiliary models are frozen when a session starts; a missing auxiliary model fails explicitly instead of silently falling back to the expensive primary model',
            'API providers and keys can be switched from the header while credentials remain in the system credential layer and only masked hints appear in the UI',
          ],
        },
      },
      {
        label: { zh: '任务交互与可见性', en: 'Task interaction and visibility' },
        items: {
          zh: [
            'AskUserQuestion 支持一次 1–3 问、单选、多选、Other 与跳过；会话权限只在规则完全一致时自动续用',
            '运行中的任务可继续接收 Steer 引导；Activity 侧栏展示 Plan、Goal、Workflow、Loop、Agent Team 与 Scheduled 的真实状态',
            '任意历史消息可安全分支到独立 Claude 会话，任意两条已完成会话可只读并排比较且不改变主任务身份',
            '归档保留原任务组并默认折叠；深层文件树按需加载，不再在约八层后丢失文件',
          ],
          en: [
            'AskUserQuestion supports one to three prompts, single and multiple choice, Other, and skip; session permissions are reused only for exactly matching rules',
            'Running tasks accept live Steer guidance, while the Activity sidebar shows authoritative Plan, Goal, Workflow, Loop, Agent Team, and Scheduled state',
            'Any historical message can fork into an independent Claude session, and any two completed conversations can be compared side by side without changing the primary task identity',
            'Archives preserve their original task groups and stay collapsed by default; deep file trees load on demand without losing files beyond roughly eight levels',
          ],
        },
      },
      {
        label: { zh: 'macOS 与可靠性', en: 'macOS and reliability' },
        items: {
          zh: [
            '保持 macOS 原生红黄绿窗口控件，红叉安全收口活跃 CLI 后真实退出；运行中可按需防止系统休眠',
            '关闭、刷新、回退和 compact 继续使用 canonical UUID/JSONL，provider/model 不兼容时保留原任务并明确失败',
            '隔离测试退出后会话、Scheduled、MCP 与 WebKit 状态全部清零，测试对话不会进入正式会话或记忆扫描',
          ],
          en: [
            'Native macOS traffic-light controls remain intact; the red close button safely settles active CLIs before exiting, and active work can keep the system awake when required',
            'Close, reload, rewind, and compact preserve the canonical UUID and JSONL; provider or model incompatibility keeps the original task and fails explicitly',
            'Isolated tests remove conversation, Scheduled, MCP, and WebKit state on exit so test chats cannot enter production sessions or memory scans',
          ],
        },
      },
    ],
  },
  {
    version: '0.14.1',
    date: '2026-07-12',
    highlights: {
      zh: [
        '顶栏以大号具体模型开头，并可直接切换 Agent Teams、API 钥匙/中转站与权限模式',
        'Claude Code 原生命令与 Skill 改为从 system:init 动态发现，不再受旧版静态清单限制',
        '左侧工作区只显示末级文件夹名，移除括号上级目录与重复路径',
      ],
      en: [
        'The top bar now leads with the concrete model and provides direct Agent Teams, API provider/key, and permission controls',
        'Claude Code native commands and Skills are discovered from system:init instead of a stale compiled catalogue',
        'The sidebar shows only the leaf workspace name, without parent-name suffixes or duplicate paths',
      ],
    },
    categories: [
      {
        label: { zh: '命令与交互', en: 'Commands and interaction' },
        items: {
          zh: [
            '原生 slash command 与 Skill 按工作目录合并，保留已有说明并标记当前运行时真实可用能力',
            'Claude 原生 `/goal` 不再被 Black Box 截获；Codex 风格持久 Goal 保留在顶栏，并提供明确的 `/codex-goal` 别名',
            '窄窗口下 Workflow、Loop、Goal 自动收为 W/L/G 紧凑按钮，避免与钥匙或权限选择器重叠',
          ],
          en: [
            'Native slash commands and Skills merge per workspace while preserving rich local descriptions and runtime availability',
            'Claude native `/goal` is no longer shadowed; the Codex-style persistent Goal stays in the toolbar with an explicit `/codex-goal` alias',
            'Workflow, Loop, and Goal collapse to compact W/L/G controls in narrow windows to prevent header overlap',
          ],
        },
      },
      {
        label: { zh: '模型与工作区', en: 'Model and workspace' },
        items: {
          zh: [
            '当前 API 供应商/钥匙菜单只显示名称和脱敏末四位，并可进入完整供应商管理',
            '当前具体模型固定在顶栏最左侧；当前文件夹从顶栏移除，工作区完整路径仍只作为内部上下文使用',
          ],
          en: [
            'The API provider/key menu shows only provider names and masked last-four hints, with a direct path to provider management',
            'The concrete model stays at the far left of the header; the current folder is removed while its full path remains internal context',
          ],
        },
      },
    ],
  },
  {
    version: '0.14.0',
    date: '2026-07-12',
    highlights: {
      zh: [
        '会话续接全面加固：关闭、刷新、回退与 compact 后继续使用同一条 Claude 会话',
        '新增持久 Goal、结构化 Plan、原生 Loop、Workflow 与五档权限模式',
        'Scheduled、Worktree、Handoff、逐文件审查和恢复快照组成完整任务闭环',
        '归档、任务组、深层文件树、扩展中心与顶部实际模型显示完成统一收口',
      ],
      en: [
        'Hardened conversation continuity across native close, reload, rewind, and compact while preserving the same Claude session',
        'Persistent Goal, structured Plan, native Loop, Workflow, and five explicit permission modes',
        'A complete Scheduled and Worktree lifecycle with Handoff, file review, and recovery snapshots',
        'Unified archive, task groups, deep file trees, Extension Center, and resolved-model visibility',
      ],
    },
    categories: [
      {
        label: { zh: '任务与 Agent', en: 'Tasks and agents' },
        items: {
          zh: [
            'Goal 支持证据完成、暂停/恢复、token 预算与重启后保守恢复；Plan 跨刷新和原生重启持久化',
            'Loop 直接使用 Claude Code 原生 Cron 工具；Workflow 绑定真实 task、run、phase 与重载恢复',
            'Agent Teams 作为显式实验开关，交互与 Scheduled 均保留 named teammate、共享任务和工具归属',
            'Scheduled run 拥有可续接会话、一级收件箱、Git Worktree、Create branch 与 Local↔Worktree Handoff',
          ],
          en: [
            'Goal supports evidence-backed completion, pause/resume, token budgets, and conservative restart recovery; Plan persists across reloads and native relaunches',
            'Loop uses Claude Code native Cron tools, while Workflow binds real tasks, runs, phases, and reload recovery',
            'Agent Teams is an explicit experimental opt-in with named teammates, shared tasks, and tool ownership in chat and Scheduled runs',
            'Scheduled runs now have resumable sessions, a first-class inbox, Git worktrees, Create branch, and Local-to-Worktree Handoff',
          ],
        },
      },
      {
        label: { zh: '可靠性与体验', en: 'Reliability and experience' },
        items: {
          zh: [
            '红叉与 Cmd-Q 会先安全收口全部活跃 CLI 再退出；关闭应用后本地 Scheduled 不继续运行',
            'reload、侧栏刷新、回退、manual/auto compact 与历史 compact 会话统一保持 canonical UUID 和 JSONL',
            '归档按原任务组展示且默认折叠，不显示不断增长的累计数字；文件树可按需展开至少 12 层',
            '顶部显示 provider 实际解析模型；Manual、Accept Edits、Plan、Auto、Bypass 可实时切换且不会混入用户正文',
            '扩展中心统一 Plugin、Skill、MCP 与 Workflow；marketplace 和 OAuth 均保持显式用户操作，不静默改配置',
          ],
          en: [
            'The red close control and Cmd-Q settle every active CLI before exit; local Scheduled tasks do not keep running after the app exits',
            'Reload, sidebar refresh, rewind, manual/auto compact, and historical compact sessions preserve one canonical UUID and JSONL',
            'Archived tasks retain their original groups, stay collapsed by default, and show no ever-growing total; file trees expand on demand beyond twelve levels',
            'The top bar shows the provider-resolved model, with live Manual, Accept Edits, Plan, Auto, and Bypass controls that never leak into user text',
            'Extension Center unifies Plugins, Skills, MCP, and Workflow while keeping marketplace and OAuth changes explicitly user-driven',
          ],
        },
      },
    ],
  },
  {
    version: '0.13.0',
    date: '2026-07-11',
    highlights: {
      zh: [
        '新增 Codex 式已安排任务：定时后台执行、运行收件箱、工具轨迹与独立 Git 工作树',
        '新增完整 MCP 与 Claude Plugin 管理，并显示 Skill、MCP 和子代理的真实调用归属',
        '模型选择统一为 Fable、Opus、Sonnet、Haiku 四档，由当前 API 配置映射具体模型',
        '新增 4 套背景材质与 4 套强调色，可独立组合并跟随浅色、深色或系统模式',
      ],
      en: [
        'Codex-style Scheduled Tasks with background runs, an inbox, tool traces, and isolated Git worktrees',
        'Full MCP and Claude Plugin management with visible Skill, MCP, and subagent ownership',
        'Four stable model tiers—Fable, Opus, Sonnet, and Haiku—resolved by the active API provider',
        'Four surfaces and four accents that combine independently across light, dark, and system modes',
      ],
    },
    categories: [
      {
        label: { zh: 'Agent 能力', en: 'Agent capabilities' },
        items: {
          zh: [
            '已安排任务支持 Cron 独立运行与 Heartbeat 回到原会话；窗口关闭后调度器继续运行，异常退出会恢复遗留状态',
            'Scheduled run 保存脱敏 Skill / Tool / MCP / Subagent 轨迹；无人值守执行采用精确许可与 fail-closed sandbox',
            'MCP 支持 local / project / user scope、项目审批、stdio / HTTP / SSE / WebSocket、health 与 OAuth 委托',
            'Plugin Manager 支持 marketplace、发现、安装、scope、启停、更新、详情和保留数据卸载',
          ],
          en: [
            'Scheduled Tasks support independent Cron runs and Heartbeats back to an existing conversation; scheduling continues after the window closes and interrupted state recovers on restart',
            'Scheduled runs retain redacted Skill, Tool, MCP, and Subagent traces with precise unattended permissions and a fail-closed sandbox',
            'MCP supports local, project, and user scopes, project approval, stdio, HTTP, SSE, WebSocket, health checks, and delegated OAuth',
            'Plugin Manager covers marketplaces, discovery, installation, scopes, enable/disable, updates, details, and uninstall with optional data retention',
          ],
        },
      },
      {
        label: { zh: '体验与安全', en: 'Experience and safety' },
        items: {
          zh: [
            'Claude CLI 更新会识别当前安装 owner，不再悄悄安装第二份 CLI；运行中的会话或任务会阻止升级',
            '旧的上游 Black Box 自动更新通道已停用，避免自有版本被错误覆盖',
            '设置页完成中英双语，主题正文、次级文字、用户气泡与交互焦点通过对比度回归',
          ],
          en: [
            'Claude CLI updates follow the current installation owner instead of silently installing a second CLI, and are blocked while sessions or tasks are running',
            'The inherited upstream Black Box updater channel is disabled so this fork cannot be overwritten by the wrong release',
            'Settings are bilingual, with contrast regressions covering text, user bubbles, and interaction focus across the theme system',
          ],
        },
      },
    ],
  },
  {
    version: '0.11.0',
    date: '2026-06-10',
    highlights: {
      zh: [
        '新增「会话分组」：左侧会话可以建组收纳，拖拽排序、右键管理',
        '新增 Claude Fable 5 模型（最强档位），可选标准版和 1M 大上下文版',
        '主题新增紫色（替换原橘色），界面细节整体打磨',
        'HTML 文件支持实时预览，聊天里的文件路径识别更聪明',
      ],
      en: [
        'New session groups: organize sessions into groups with drag-to-reorder and right-click management',
        'Added Claude Fable 5 (the most capable tier) — standard and 1M-context variants',
        'New purple theme (replaces orange) with overall UI polish',
        'HTML live preview, plus smarter file-path detection in chat',
      ],
    },
    categories: [
      {
        label: { zh: '新增', en: 'New' },
        items: {
          zh: [
            '会话分组 — 工作区下可建「组」收纳会话：组卡片拖拽重排、右键归组/移出/重命名/删除、组内直接新建会话；会话文件永不移动，归组换组不影响续聊',
            'Claude Fable 5 模型支持 — 列表新增 Fable 5 标准版和 1M 上下文版并置顶，默认模型仍是 Sonnet 4.6',
            'HTML 实时预览 — 预览 HTML 文件时脚本可执行，交互页面直接看到运行效果',
          ],
          en: [
            'Session groups — create groups under a workspace to organize sessions: drag group cards to reorder, right-click to assign/remove/rename/delete, create sessions inside a group; session files never move, so resuming is never affected',
            'Claude Fable 5 support — standard and 1M-context variants added at the top of the model list; default stays Sonnet 4.6',
            'HTML live preview — scripts run inside the HTML preview so interactive pages render for real',
          ],
        },
      },
      {
        label: { zh: '改进', en: 'Improved' },
        items: {
          zh: [
            '紫主题替换橘色 — 原来选橘色的会自动切换，气泡对齐、圆角、深色卡片配色整体打磨',
            '文件路径识别更聪明 — 隐藏目录（.claude/）、无扩展名路径（src/build）、中文文件名都能点击定位，正文里的裸路径自动可点',
            '旧版 CLI 选 Fable 5 时给出明确的「请升级 CLI」提示，不再误导你去换模型',
          ],
          en: [
            'Purple theme replaces orange — existing orange users switch automatically; bubble alignment, radii and dark-card colors polished throughout',
            'Smarter file-path detection — hidden dirs (.claude/), extension-less paths (src/build) and CJK filenames are all clickable; bare paths in messages become clickable too',
            'Selecting Fable 5 on an outdated CLI now shows a clear "please update your CLI" hint instead of suggesting a model switch',
          ],
        },
      },
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: [
            '流式内容不再被缓存清理误伤 — 有未投递流式文本的会话不会被后台清理，已经看到的内容不再静默丢失（发现自 @suyuan2022）',
            '新建会话掉组 — 新会话拿到正式 id 后仍留在原来的组里',
          ],
          en: [
            'Streaming content protected from cache eviction — sessions with undelivered streamed text are never evicted, so what you saw never silently disappears (originally reported by @suyuan2022)',
            'New sessions no longer fall out of their group once they receive a real session id',
          ],
        },
      },
    ],
  },
  {
    version: '0.10.8',
    date: '2026-05-29',
    highlights: {
      zh: [
        '新增 Claude Opus 4.8 模型，可选标准版和 1M 大上下文版',
        '原来用 Opus 4.7 的会自动切到 4.8，不用手动改',
        '修复拖拽文件落点和微信分享的几个问题',
      ],
      en: [
        'Added Claude Opus 4.8 — choose the standard or 1M-context variant',
        'Existing Opus 4.7 selections migrate to Opus 4.8 automatically',
        'Fixed file drag-and-drop positioning and WeChat sharing',
      ],
    },
    categories: [
      {
        label: { zh: '新增', en: 'New' },
        items: {
          zh: [
            'Claude Opus 4.8 模型支持 — 列表新增 Opus 4.8 标准版和 1M 上下文版并置顶，默认模型仍是 Sonnet 4.6',
            '原来选 Opus 4.7 的设置会自动迁移到 Opus 4.8',
          ],
          en: [
            'Claude Opus 4.8 support — standard and 1M-context variants added at the top of the model list; default stays Sonnet 4.6',
            'Existing Opus 4.7 selections are migrated to Opus 4.8 automatically',
          ],
        },
      },
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: [
            '拖拽文件落点更准 — 拖拽改用 Webview API + DPR 感知坐标，高分屏下识别更准',
            '微信分享更可靠 — 增加剪贴板 + URL scheme 兜底',
          ],
          en: [
            'More accurate file drag-and-drop — switched to the Webview drag API with DPR-aware coordinates for high-DPI displays',
            'More reliable WeChat sharing — added clipboard and URL-scheme fallbacks',
          ],
        },
      },
    ],
  },
  {
    version: '0.10.7',
    date: '2026-04-27',
    highlights: {
      zh: [
        '会话生命周期和流式体验稳定性大修，切会话 / 切模型更稳',
        'API 重试和限流状态会直接显示在对话活动区',
        '移除外部 Web Font 依赖，改用本地系统字体栈',
      ],
      en: [
        'Session lifecycle and streaming stability overhaul for safer session/model switching',
        'API retry and rate-limit status now appears directly in the activity area',
        'Removed external web font dependency and switched to the local system font stack',
      ],
    },
    categories: [
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: [
            '会话生命周期和流式体验稳定性大修 — 切会话 / 切 Provider / 切 Model 时的清理统一走 lifecycle 入口，减少 stdin 路由串台',
            '子进程隐性退出时界面会正确收尾，不会一直转圈',
            'Stop 之后再发消息继续走当前会话，Thinking 计时器不再闪负数',
            'Provider 流式体验贴近原生 CLI，减少重复 thinking 块，stop / interrupt 后能恢复',
            '本地系统字体栈 — 移除外部 Web Font 依赖，离线或网络不稳定时界面字体也能稳定加载',
          ],
          en: [
            'Session lifecycle and streaming stability overhaul — cleanup now goes through the lifecycle path when switching sessions, providers, or models, reducing stdin route cross-talk',
            'Hidden child-process exits now finalize the UI correctly instead of spinning forever',
            'Sending after Stop stays in the current session, and the thinking timer no longer flashes negative values',
            'Provider streaming is closer to the native CLI, with fewer duplicate thinking blocks and recovery after stop / interrupt',
            'Local system font stack — removed the external web font dependency so typography stays stable offline or on poor networks',
          ],
        },
      },
      {
        label: { zh: '新增', en: 'New' },
        items: {
          zh: [
            '能力边界加固 — Markdown 图片 / HTML/SVG 预览 / 文件系统授权走后端路径校验',
            'Opus 4.7 规范化 — CLI 模型名统一到明确的 1M variant',
            '.test CLI 测试框架 — 覆盖 lifecycle / routing / provider / interrupt / streaming 多组回归场景',
          ],
          en: [
            'Capability boundary hardening — Markdown images, HTML/SVG preview, and filesystem access now go through backend path validation',
            'Opus 4.7 normalization — CLI model names now map to the explicit 1M variant',
            '.test CLI framework — regression coverage for lifecycle, routing, provider, interrupt, and streaming flows',
          ],
        },
      },
    ],
  },
  {
    version: '0.10.6',
    date: '2026-04-18',
    highlights: {
      zh: [
        'Windows 装不上 Claude CLI 的问题修好了（「不支持的 16 位应用程序」）',
        '一批切会话、中断消息、卡「运行中」的老毛病都修了',
        '跟 CC Switch 共存时会给出友好提示',
      ],
      en: [
        'Fixed Windows Claude CLI install failure ("16-bit application not supported")',
        'Batch of fixes for workspace switching, interrupted messages, and stuck "running" sessions',
        'Friendly notice when CC Switch is installed alongside',
      ],
    },
    categories: [
      {
        label: { zh: '新增', en: 'New' },
        items: {
          zh: [
            '跟 CC Switch 共存时的友好提示 — 检测到同时装了 CC Switch，设置里会直接告诉你它俩怎么配合，不用自己琢磨',
          ],
          en: [
            'CC Switch coexistence notice — when both are installed, Settings tells you how they work together',
          ],
        },
      },
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: [
            'Windows 装不上 Claude CLI — 之前装完打开会弹「不支持的 16 位应用程序」完全没法用。这版改成从官方直接下载绕开问题包，遇到坏掉的 CLI 会自动识别清理；设置 → CLI 新增「修复」按钮一键清理重装；国内用户自动挑版本最新的下载源',
            '连续切换会话偶尔串流 / 丢流 — 刚切过去的会话看到别人的内容，或者自己发的消息直接没了。修好',
            '中断消息后再发，容易绑错位置 — 重发的消息会误贴到上一条被中断的记录上。修好',
            '重启后有会话卡在「运行中」 — 明明已经结束，界面上还一直转圈。修好',
            '改完设置要刷新才生效 — 现在改完立即响应',
            '标题生成偶尔卡住 — 加了 10 秒超时，不会再无限等待',
          ],
          en: [
            'Windows Claude CLI install — previously crashed with "16-bit application not supported" and was unusable. Now downloads from the official source directly, self-heals corrupt installs, and Settings → CLI has a one-click Repair button. Mainland users auto-select the most up-to-date mirror',
            'Occasional stream cross-talk / missing messages when switching sessions quickly — fixed',
            'Sending after interrupting a message could attach the new message to the wrong record — fixed',
            'Sessions stuck spinning as "running" after restart — fixed',
            'Settings changes required a refresh to take effect — now instant',
            'Title generation occasionally hung — now has a 10 s timeout',
          ],
        },
      },
    ],
  },
  {
    version: '0.10.5',
    date: '2026-04-17',
    highlights: {
      zh: [
        '紧急修复：第三方 Provider 在 v0.10.3+ 下不响应',
        '紧急修复：频繁切换工作区后界面整体冻结',
      ],
      en: [
        'Hot-fix: third-party providers unresponsive since v0.10.3',
        'Hot-fix: UI freeze after frequent workspace switches',
      ],
    },
    categories: [
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: [
            '第三方 Provider 发消息不响应 — v0.10.3 对 ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN 写入空字符串让 CLI 进入 OAuth 路径触发 oauth_token_refresh 死锁；--setting-sources project,local 又让 CLI 对第三方 endpoint 构造错误请求 → 429。去掉两处后，env_remove 路径仍保留防 CCswitch 继承',
            '频繁切换工作区后 CLI 管理 / 文件树 / chat 整体冻结 — read_dir_recursive 的 sort_by closure 在比较时调 is_dir() 文件系统 syscall，CLI 同时写 SDK checkpoint 文件导致同一 entry 两次返回不同值，Rust 1.81+ 严格 total-order 检查 panic tokio worker，所有 async command 挂起。改为预先缓存 is_dir() 再排序',
          ],
          en: [
            'Third-party providers unresponsive — v0.10.3 wrote empty strings to ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN pushing the CLI onto the OAuth path which deadlocked via oauth_token_refresh; --setting-sources project,local also caused the CLI to build bad requests against third-party endpoints → 429. Both removed; env_remove path retained to still block CCswitch inheritance',
            'UI freeze after workspace switches — read_dir_recursive\'s sort_by closure called is_dir() per comparison; concurrent SDK checkpoint writes made the same entry return inconsistent values, violating Rust 1.81+\'s strict total-order check, panicking tokio worker and hanging all async tauri commands. Now caches is_dir() before sorting',
          ],
        },
      },
    ],
  },
  {
    version: '0.10.4',
    date: '2026-04-17',
    highlights: {
      zh: [
        'Opus 4.7 支持 — 默认 1M 上下文，老版本号自动迁移',
        '滚动条改成自动隐藏 — 鼠标悬停时才浮现',
      ],
      en: [
        'Opus 4.7 support — 1M context by default, legacy model IDs auto-migrated',
        'Auto-hide scrollbars — fade in on hover, invisible otherwise',
      ],
    },
    categories: [
      {
        label: { zh: '新功能', en: 'New' },
        items: {
          zh: [
            'Claude Opus 4.7 模型支持 — 默认 1M 上下文窗口，无需额外 beta flag；老用户的 claude-opus-4-6 / -1m 设置会自动迁移到 claude-opus-4-7',
          ],
          en: [
            'Claude Opus 4.7 model support — 1M context by default, no beta flag needed; legacy claude-opus-4-6 / -1m settings auto-migrate to claude-opus-4-7',
          ],
        },
      },
      {
        label: { zh: '改进', en: 'Improved' },
        items: {
          zh: [
            '滚动条改成自动隐藏 — 默认不可见，指针移入可滚动区域时才淡入；粗细从 5px 调到 6px，视觉更轻盈',
          ],
          en: [
            'Auto-hide scrollbars — invisible by default, fade in on hover over scrollable regions; width tuned from 5px to 6px',
          ],
        },
      },
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: [
            '标题生成命令 401 错误 — Claude Desktop 注入的 OAuth token 通过环境变量污染第三方 Provider 的 title gen，三层防御：env 清除 + --setting-sources + args 可变声明',
          ],
          en: [
            'Title-gen 401 errors — Claude Desktop\'s OAuth token polluted title-gen for third-party providers; fixed with env cleanup + --setting-sources + mutable args declaration',
          ],
        },
      },
    ],
  },
  {
    version: '0.10.3',
    date: '2026-04-16',
    highlights: {
      zh: [
        'Cmd+F 页内文本查找',
        'CCswitch + Claude Desktop 共存 — 第三方 Provider 不再 401',
      ],
      en: [
        'Cmd+F find in page',
        'CCswitch + Claude Desktop coexistence — third-party providers no longer 401',
      ],
    },
    categories: [
      {
        label: { zh: '新功能', en: 'New' },
        items: {
          zh: ['Cmd+F / Ctrl+F 页内文本查找 — 实时高亮 + 上下跳转'],
          en: ['Cmd+F / Ctrl+F find in page — live highlighting + navigation'],
        },
      },
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: [
            'Claude Desktop 启动时继承的 CLAUDE_CODE_OAUTH_TOKEN 覆盖第三方 Provider API Key 导致 401 — env 清除 + 空字符串覆盖 + gateway 拦截 oauth_token_refresh',
            'hook_started/progress/response/status/api_retry 事件导致控制台大量警告 — 静默处理',
          ],
          en: [
            'CLAUDE_CODE_OAUTH_TOKEN inherited from Claude Desktop overrides third-party API Key causing 401 — env cleanup + empty string override + gateway blocks oauth_token_refresh',
            'hook_started/progress/response/status/api_retry events flooding console — silently handled',
          ],
        },
      },
    ],
  },
  {
    version: '0.10.2',
    date: '2026-04-11',
    highlights: {
      zh: [
        '新增用户反馈通道，设置里一键提交',
        '流式输出卡死大修 — 孤儿缓冲、停滞看门狗、打断保留一整套',
        '切换模型不再 400 报错',
        '/compact 在后台 tab 完成时不再卡住转圈',
        '工具调用有运行中动画，消息可排队发送',
      ],
      en: [
        'New in-app feedback channel in Settings',
        'Stream stuck fixes — orphan buffer, stall watchdog, interrupt preservation',
        'Model switching no longer hits 400 errors',
        '/compact no longer freezes when it completes on a background tab',
        'Tool calls animate while running, new messages can queue up',
      ],
    },
    categories: [
      {
        label: { zh: '新功能', en: 'New' },
        items: {
          zh: [
            '提交反馈 — 设置里新增「反馈」tab，可以直接给开发者发问题或建议，支持粘贴截图，会自动带上应用版本、系统、Provider、Model 等诊断信息，无需打开 GitHub',
          ],
          en: [
            'Submit Feedback — a new "Feedback" tab in Settings lets you send bug reports or suggestions directly to the developer, with screenshot paste support; app version, OS, provider, and model are attached automatically — no GitHub account needed',
          ],
        },
      },
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: [
            '流式输出偶尔卡住、结尾漏字 — 新增孤儿缓冲队列 + 3 秒停滞看门狗，路由失效时缓冲不再被静默清空',
            '按停止按钮后已流出的文字丢失 — 现在会作为一条消息保留在对话里',
            '切换模型后 400 "invalid thinking signature" 报错 — 改为在 resume 前直接清理 JSONL 中的 thinking 块',
            '切换 Provider 后的 signature 不匹配 — 同步清理本地 thinking 历史',
            '/compact 在后台 tab 完成时卡片一直转圈 — 前后台的 pending command 状态现在都会在 result/assistant 到达时清理',
            '切换 tab 时 thinking 内容丢失 — 后台 tab 的 stream handler 现在也处理 thinking_delta',
            '子 agent 请求权限时锁住主输入框 — 权限请求现在携带 parent_tool_use_id / agent_id 以区分层级',
            '从 Finder 拖文件到输入框会同时插入文件 chip 和原始文本路径 — 新增 drop 拦截',
            'Rewind 后事件偶尔路由到错误 tab — killProcess 现在会清理 stdin → tab 映射',
            '流式缓冲区对中文字符使用字节切片导致 panic，进而杀死整个 stdout 读取任务 — 改为安全的字符边界检查',
            '"注入 PATH" 之前写的是错误的 marker 且反复点击会累积多个块（#79）— 现在会拒绝无效 CLI 候选（broken symlink / 空目录 / 非可执行文件），marker 正名为 `# Added by BLACKBOX`，每次注入前先剥离自己的历史块',
          ],
          en: [
            'Stream output occasionally stalled or dropped trailing characters — added orphan buffer queue + 3-second stall watchdog; flushes are no longer silently discarded when routing is unresolved',
            'Streamed text was lost when the Stop button was pressed — it is now preserved as a regular message in the transcript',
            '"Invalid thinking signature" 400 errors after switching model — JSONL thinking blocks are now stripped before --resume',
            'Provider switch signature mismatch — local thinking history is cleaned on provider change as well',
            '/compact command card spun forever when it completed on a background tab — pendingCommand state is now cleared from both foreground and background handlers',
            'Thinking content disappeared after tab switching — background stream handler now processes thinking_delta',
            'Sub-agent permission requests locked the main input bar — requests now carry parent_tool_use_id / agent_id to identify their layer',
            'Finder file drag inserted both a file chip and a raw text path — added drop interception',
            'Events occasionally routed to the wrong tab after Rewind — killProcess now cleans up the stdin → tab mapping',
            'Stream buffer byte-slicing panicked on Chinese characters and killed the entire stdout reader task — now uses safe char-boundary checks',
            '"Inject PATH" wrote a wrong marker and accumulated duplicate blocks on repeat clicks (#79) — now rejects invalid CLI candidates (broken symlinks, empty dirs, non-executable files), marker renamed to `# Added by BLACKBOX`, and each inject strips its own historical blocks first',
          ],
        },
      },
      {
        label: { zh: '改进', en: 'Improved' },
        items: {
          zh: [
            '工具调用运行中会显示 3 个跳动的圆点动画，长任务不再像死机',
            '当前 AI 正在回复时按 Enter 发送的新消息会进入排队队列，等回复完成后自动合并发送',
            'ModelSelector 下拉和底部按钮现在都显示实际调用的 provider 模型名（如 mimo-v2-pro），而非 Claude tier 名',
            '重连状态下 ActivityIndicator 会显示明确的"重连中"提示',
          ],
          en: [
            'Running tool calls now show a 3-dot typing animation so long tasks no longer look frozen',
            'Messages sent while AI is still replying now queue up and merge into a single follow-up when the reply finishes',
            'ModelSelector dropdown and collapsed button now both show the actual provider model name (e.g. mimo-v2-pro) instead of the Claude tier label',
            'Reconnecting state is now explicitly shown in the ActivityIndicator',
          ],
        },
      },
    ],
  },
  {
    version: '0.10.1',
    date: '2026-04-09',
    highlights: {
      zh: ['修复输出偶尔卡住的问题', '同名文件夹不再混淆'],
      en: ['Fix occasional output freeze', 'Same-name folders now distinguishable'],
    },
    categories: [
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: [
            '流式输出偶尔卡死 — 新增定时兜底机制，长对话时输出不再停在某个字不动',
            '不同路径的同名文件夹现在能正确区分 — 显示父级目录（如「A (桌面)」vs「A (坚果云)」）',
          ],
          en: [
            'Streaming output freeze — added timer fallback so output never gets stuck mid-response',
            'Same-name folders from different paths now show parent directory for disambiguation',
          ],
        },
      },
    ],
  },
  {
    version: '0.10.0',
    date: '2026-04-05',
    highlights: {
      zh: ['CLI 管理面板 + CLI 发现机制重构'],
      en: ['CLI management panel + CLI discovery overhaul'],
    },
    categories: [
      {
        label: { zh: '新功能', en: 'New' },
        items: {
          zh: [
            'CLI 管理面板 — 扫描所有 CLI 安装，按来源分层显示，支持 Pin/删除/PATH 注入',
          ],
          en: [
            'CLI management panel — scan all CLI installations by source tier, Pin/delete/PATH inject',
          ],
        },
      },
      {
        label: { zh: '改进', en: 'Improved' },
        items: {
          zh: [
            'CLI 发现优先级重构：Official → System → 自部署 → 版本管理器 → 动态',
            'CLI 更新智能路由：检测来源选择 native 或 npm 路线，不再全走 npm',
            '重装前自动清理旧版本，防止残留干扰',
          ],
          en: [
            'CLI discovery rewritten: Official → System → AppLocal → VersionManager → Dynamic',
            'Smart CLI update routing: native binary for Official/System, npm for AppLocal',
            'Auto-cleanup of stale CLI before reinstall',
          ],
        },
      },
    ],
  },
  {
    version: '0.9.9',
    date: '2026-04-04',
    highlights: {
      zh: ['CLI 更新体验全面优化：进度条 + 版本校验 + 镜像加速'],
      en: ['CLI update UX overhaul: progress bar + version verification + mirror acceleration'],
    },
    categories: [
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: [
            'CLI 更新增加进度条，不再只有转圈动画',
            'npm 镜像版本过期时自动回退到官方源重试',
            '版本检查走 herear.cn 镜像 + 语义化比较，修复误报「有新版本」',
            '设置页 CLI 管理标签显示红点，一眼知道是什么要更新',
          ],
          en: [
            'CLI update now shows progress bar instead of just a spinner',
            'Stale npm mirror auto-retries with official registry',
            'Version check via herear.cn mirror + proper semver comparison, fixing false update prompts',
            'CLI tab in settings shows red dot when update is available',
          ],
        },
      },
    ],
  },
  {
    version: '0.9.7',
    date: '2026-04-04',
    highlights: {
      zh: ['CLI 一键更新 + MiMo Token Plan + 多项修复'],
      en: ['One-click CLI update + MiMo Token Plan + multiple fixes'],
    },
    categories: [
      {
        label: { zh: '新功能', en: 'Added' },
        items: {
          zh: [
            'MiMo Token Plan 预设 — 订阅用户专属接入点',
            'CLI 更新按钮 — 设置页一键升级 + 自动检测新版本（红点提醒）',
          ],
          en: [
            'MiMo Token Plan preset — dedicated endpoint for subscribers',
            'CLI update button — one-click upgrade in settings + auto-detect new versions',
          ],
        },
      },
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: [
            '测试连接不再误报 — MiMo 等渠道点「测试」终于能过了',
            'Opus 1M 选择修复 — 不再和 Opus 合并，重启后也不会重置',
            '暗色模式文字更清晰 — 对比度提升至 WCAG AA 标准',
          ],
          en: [
            'Connection test no longer false-fails for MiMo and similar providers',
            'Opus 1M selection preserved — no longer merged with regular Opus',
            'Dark mode text contrast improved to WCAG AA standard',
          ],
        },
      },
    ],
  },
  {
    version: '0.9.6',
    date: '2026-04-03',
    highlights: {
      zh: ['4 个核心 Bug 修复 — 消息不再丢、图片能正常拖、流式不再卡'],
      en: ['4 core bug fixes — messages no longer lost, images drag properly, streaming no longer freezes'],
    },
    categories: [
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: [
            'AI 回复中补发消息不再丢失 — 排队等 AI 说完再自动发送',
            '拖拽图片到对话框不再变成纯文本路径 — 现在有缩略图预览',
            '第三方渠道（中转/Bedrock/Vertex）不再报 400 错误 — 自动关闭不兼容的 beta 功能',
            '流式输出不再中途卡住 — 修复了后端读取中断和缓冲区数据丢失的问题',
          ],
          en: [
            'Messages sent during AI reply no longer silently dropped — queued and auto-sent',
            'Dragging images into chat now shows thumbnail previews instead of bare file paths',
            'Third-party providers (proxies/Bedrock/Vertex) no longer get 400 errors from beta flags',
            'Streaming output no longer freezes mid-response — fixed backend read errors and buffer data loss',
          ],
        },
      },
    ],
  },
  {
    version: '0.9.4',
    date: '2026-03-31',
    highlights: {
      zh: ['一次修了 5 个共性 Bug + 新增 Kimi Code 渠道'],
      en: ['5 shared bug fixes in one go + Kimi Code provider added'],
    },
    categories: [
      {
        label: { zh: '新功能', en: 'Added' },
        items: {
          zh: [
            'Kimi Code 预设 — 新增 Kimi Code 编程专用接入点，与 Kimi 开放平台分开配置',
          ],
          en: [
            'Kimi Code preset — dedicated coding endpoint, separate from Kimi open platform',
          ],
        },
      },
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: [
            '斜杠命令回车发不出 — 输入命令后按回车现在能正常发送了',
            '文件路径不再跳浏览器 — AGENTS.md 这类文件名不会被当成链接了',
            'Base64 图片能正常显示了',
            '面板边缘拖拽不再触发意外 resize',
            'Bedrock 渠道不再报 400 错误 — 自动处理兼容性问题',
            '关闭提示现在有中英文了',
          ],
          en: [
            'Slash command Enter key — now sends correctly instead of being swallowed',
            'File paths no longer open browser — AGENTS.md etc. render as code, not links',
            'Base64 images render properly in Markdown preview',
            'Panel edge drag no longer triggers accidental resize',
            'Bedrock provider 400 error — auto-disables incompatible beta flags',
            'Exit confirmation dialog now localized',
          ],
        },
      },
    ],
  },
  {
    version: '0.9.3',
    date: '2026-03-29',
    highlights: {
      zh: ['第三方渠道代理支持 — OpenRouter 等有地区限制的渠道现在能自动走代理'],
      en: ['Provider proxy support — auto-detect and route through proxy for region-restricted providers like OpenRouter'],
    },
    categories: [
      {
        label: { zh: '新功能', en: 'Added' },
        items: {
          zh: [
            'Provider 代理设置 — 在渠道配置中可设置代理地址，解决 OpenRouter 等地区限制问题',
            '自动代理检测 — 自动识别系统代理、Clash/Surge 等常见代理端口，无需手动配置',
          ],
          en: [
            'Provider proxy setting — configure proxy URL per provider to bypass region restrictions (e.g. OpenRouter)',
            'Auto proxy detection — automatically detects system proxy, Clash/Surge and common proxy ports',
          ],
        },
      },
    ],
  },
  {
    version: '0.9.2',
    date: '2026-03-28',
    highlights: {
      zh: ['流式输出卡住修复 + 字体上限提升'],
      en: ['Streaming freeze fix + font size limit raised'],
    },
    categories: [
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: [
            '流式输出不再卡住 — 映射丢失时自动修复，后端完成但前端不渲染的问题已解决',
          ],
          en: [
            'Streaming no longer freezes — auto-repair on mapping loss, fixes backend-complete-but-not-rendered issue',
          ],
        },
      },
      {
        label: { zh: '优化', en: 'Improved' },
        items: {
          zh: ['字体大小上限从 24 提升到 36'],
          en: ['Font size upper limit raised from 24 to 36'],
        },
      },
    ],
  },
  {
    version: '0.9.1',
    date: '2026-03-26',
    highlights: {
      zh: ['多任务完全隔离 + 37 个 Issue 修复'],
      en: ['Full multi-task isolation + 37 issue fixes'],
    },
    categories: [
      {
        label: { zh: '架构', en: 'Architecture' },
        items: {
          zh: [
            '多任务完全隔离 — 每个 tab 独立消息、streaming 状态、session meta',
            'chatStore v2 — 数据只在 tabs Map 中，结构上不可能串台',
          ],
          en: [
            'Full multi-task isolation — each tab owns independent messages, streaming state, session meta',
            'chatStore v2 — all data in tabs Map, cross-tab contamination structurally impossible',
          ],
        },
      },
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: [
            'Markdown 渲染崩溃白屏 — MarkdownErrorBoundary 隔离',
            '切换模型后 SESSION_ALREADY_ACTIVE 报错',
            '后台 Agent Team 切换会话后静默终止',
            '消息串台到其他对话窗口',
            '同一 API 多窗口卡「思考中」',
            'API 供应商配置中途回退 — snapshotProviderId',
            '续聊 thinking block 导致 400',
            '文件夹重命名 CLI symlink 断裂',
            'npm 安装的 CLI 检测不到',
            'MCP 配置双层嵌套报错',
            'Agent Team 副代理不显示',
          ],
          en: [
            'Markdown rendering crash — MarkdownErrorBoundary isolation',
            'SESSION_ALREADY_ACTIVE after model switch',
            'Background Agent Team silently terminated on tab switch',
            'Messages leaking to other chat windows',
            'Multi-window stuck on "thinking" with same API',
            'API provider config rollback — snapshotProviderId',
            'Thinking block causes 400 on resume',
            'Folder rename breaks CLI symlink',
            'npm-installed CLI not detected',
            'MCP double-nested config error',
            'Agent Team sub-agents not displayed',
          ],
        },
      },
      {
        label: { zh: '体验', en: 'UX' },
        items: {
          zh: [
            '退出确认弹窗中文化',
            '侧边栏横向滚动条消除',
            '文件树自动刷新',
            '任务历史时间戳修复',
            '错误提示中文化',
          ],
          en: [
            'Exit confirm dialog localized',
            'Sidebar scrollbar removed',
            'File tree auto-refresh',
            'Task history timestamps fixed',
            'Error messages localized',
          ],
        },
      },
    ],
  },
  {
    version: '0.8.22',
    date: '2026-03-21',
    highlights: {
      zh: ['微信分享修复 + Windows 分享支持'],
      en: ['WeChat share fix + Windows share support'],
    },
    categories: [
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: [
            '微信分享 — 修复 Mac 端间歇性无反应，失败时 toast 提示',
            'Windows 微信分享 — 剪贴板方案，跨平台可用',
          ],
          en: [
            'WeChat share — fix intermittent failure on Mac, error toast on failure',
            'Windows WeChat share — clipboard-based, cross-platform',
          ],
        },
      },
    ],
  },
  {
    version: '0.8.21',
    date: '2026-03-20',
    highlights: {
      zh: ['OpenRouter 预设 + 自定义模型 + CLI 搜索路径修复'],
      en: ['OpenRouter preset + custom models + CLI path fix'],
    },
    categories: [
      {
        label: { zh: '新增', en: 'Added' },
        items: {
          zh: [
            'OpenRouter 预设 — 支持 300+ 模型，自动处理认证',
            '自定义模型 — 在模型选择器直接添加和切换额外模型',
            '"添加新模型" — 单输入框，填模型名即可',
          ],
          en: [
            'OpenRouter preset — 300+ models, auto auth handling',
            'Custom models — add and switch extra models in selector',
            '"Add model" — single input, just type the model name',
          ],
        },
      },
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: [
            'CLI 搜索路径补全：NVM / fnm / Volta / Bun + which/where 兜底',
            'Shell PATH 超时放宽至 5 秒',
          ],
          en: [
            'CLI search: NVM / fnm / Volta / Bun + which/where fallback',
            'Shell PATH timeout extended to 5s',
          ],
        },
      },
    ],
  },
  {
    version: '0.8.20',
    date: '2026-03-19',
    highlights: {
      zh: ['MiMo 模型映射优化：Pro 启用 1M 上下文'],
      en: ['MiMo model mapping: Pro with 1M context'],
    },
    categories: [
      {
        label: { zh: '优化', en: 'Changed' },
        items: {
          zh: [
            'mimo-v2-pro 启用 1M 上下文，haiku 默认模型改为 mimo-v2-pro',
          ],
          en: [
            'mimo-v2-pro now uses 1M context, haiku default changed to mimo-v2-pro',
          ],
        },
      },
    ],
  },
  {
    version: '0.8.19',
    date: '2026-03-19',
    highlights: {
      zh: ['新增小米 MiMo 大模型预设'],
      en: ['Add Xiaomi MiMo model preset'],
    },
    categories: [
      {
        label: { zh: '新增', en: 'Added' },
        items: {
          zh: [
            '小米 MiMo Provider 预设 — 支持 mimo-v2-pro / mimo-v2-omni / mimo-v2-flash 三款模型',
          ],
          en: [
            'Xiaomi MiMo provider preset — supports mimo-v2-pro / mimo-v2-omni / mimo-v2-flash models',
          ],
        },
      },
    ],
  },
  {
    version: '0.8.18',
    date: '2026-03-19',
    highlights: {
      zh: ['MiniMax 等中文 Provider 卡死修复 + MiniMax 配置升级'],
      en: ['Fix Chinese provider stream freeze + MiniMax config upgrade'],
    },
    categories: [
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: [
            'stdout UTF-8 切割 panic — 中文 Provider 响应导致流式输出永久中断，现已修复',
            'MiniMax 配置修正 — thinkingSupport 改为 full，默认模型升级至 M2.7，新增推荐超时',
          ],
          en: [
            'stdout UTF-8 slice panic — Chinese provider responses crashed stdout reader, now fixed',
            'MiniMax config fix — thinkingSupport set to full, default models upgraded to M2.7, timeout added',
          ],
        },
      },
    ],
  },
  {
    version: '0.8.17',
    date: '2026-03-18',
    highlights: {
      zh: ['国产大模型接入体系 + 回车键修复 + CLI 搜索重构'],
      en: ['Domestic LLM provider system + Enter key fix + CLI search refactor'],
    },
    categories: [
      {
        label: { zh: '新功能', en: 'New' },
        items: {
          zh: [
            '5 家国产大模型预设（GLM / Kimi / MiniMax / 通义千问），一键获取 Key',
            '自定义模型映射 + Thinking 联动提示',
          ],
          en: [
            '5 domestic LLM presets (GLM / Kimi / MiniMax / Qwen) with one-click Key link',
            'Custom model mapping + Thinking support indicators',
          ],
        },
      },
      {
        label: { zh: '修复', en: 'Fixes' },
        items: {
          zh: [
            '回车键发不出消息（中文输入法状态卡住）',
            'GLM 模型选择器重复显示',
            'CLI 找不到时的错误处理优化',
          ],
          en: [
            'Enter key not sending (IME composing state stuck)',
            'Duplicate models in selector when using GLM',
            'Better error handling when CLI binary not found',
          ],
        },
      },
    ],
  },
  {
    version: '0.8.16',
    date: '2026-03-18',
    highlights: {
      zh: ['智谱 GLM 模型分级映射'],
      en: ['GLM model tier mapping'],
    },
    categories: [
      {
        label: { zh: '改进', en: 'Improvements' },
        items: {
          zh: ['智谱 GLM 预设按能力分级：Opus → glm-5, Sonnet → glm-5-turbo, Haiku → glm-4.7'],
          en: ['GLM preset now maps by tier: Opus → glm-5, Sonnet → glm-5-turbo, Haiku → glm-4.7'],
        },
      },
    ],
  },
  {
    version: '0.8.15',
    date: '2026-03-17',
    highlights: {
      zh: ['6 个 Bug 修复 + CLI 全链路加固'],
      en: ['6 bug fixes + CLI lifecycle hardening'],
    },
    categories: [
      {
        label: { zh: '修复', en: 'Fixes' },
        items: {
          zh: [
            'AI 运行中发送的补充消息不再丢失',
            '/compact 完成后不再卡转圈',
            'Agent 运行时可以继续发消息',
            '中文输入法回车上屏不再被拦截',
            'CLI 版本检测不再误报「过旧」',
            '重装 CLI 现在真正执行安装',
          ],
          en: [
            'Messages sent during AI processing no longer lost',
            '/compact no longer leaves GUI spinning',
            'Can send messages while Agent is running',
            'Chinese IME enter key no longer intercepted',
            'CLI version check no longer falsely reports "too old"',
            'Reinstall CLI now actually performs installation',
          ],
        },
      },
      {
        label: { zh: '改进', en: 'Improvements' },
        items: {
          zh: [
            'CLI 全链路加固：登录 shell 超时保护、二进制校验、安装超时',
          ],
          en: [
            'CLI lifecycle hardening: login shell timeout, binary verification, install timeout',
          ],
        },
      },
    ],
  },
  {
    version: '0.8.14',
    date: '2026-03-17',
    highlights: {
      zh: ['支持 Opus 4.6 (1M) 超长上下文 + 极致思考模式，修复 15 个问题'],
      en: ['Opus 4.6 (1M) ultra-long context + max thinking, 15 issues fixed'],
    },
    categories: [
      {
        label: { zh: '新功能', en: 'New' },
        items: {
          zh: [
            '模型选择器新增 Opus 4.6 (1M context) 超长上下文选项',
            '思考级别新增「极致思考」（max effort）',
            '启动时检测 CLI 版本兼容性，旧版自动引导升级',
          ],
          en: [
            'Model selector adds Opus 4.6 (1M context) ultra-long context option',
            'Thinking level adds "Max Think" (max effort)',
            'CLI version compatibility check on startup, auto-guides upgrade for old versions',
          ],
        },
      },
      {
        label: { zh: '修复', en: 'Fixes' },
        items: {
          zh: [
            '中文输入法回车不再被拦截为提交',
            'Markdown 加粗紧跟中文标点现在正确渲染',
            '/context 命令不再重复显示内容',
            '中转站各渠道默认配置修正（智谱/Kimi/MiniMax）',
            '隐藏 OpenAI 格式选项，默认使用 Anthropic 协议',
            '长时间运行提示不再误导用户中断任务',
          ],
          en: [
            'Chinese IME enter key no longer intercepted as form submit',
            'Markdown bold with CJK punctuation now renders correctly',
            '/context command no longer shows content twice',
            'Fixed default config for relay channels (Zhipu/Kimi/MiniMax)',
            'Hidden OpenAI format option, defaults to Anthropic protocol',
            'Long-running task prompt no longer misleads users to stop',
          ],
        },
      },
    ],
  },
  {
    version: '0.8.13',
    date: '2026-03-14',
    highlights: {
      zh: ['新增原生二进制安装 Claude CLI，无需 Node.js'],
      en: ['Native binary CLI installation, no Node.js required'],
    },
    categories: [
      {
        label: { zh: '新功能', en: 'New' },
        items: {
          zh: [
            '支持从 GCS 直接下载 Claude Code 原生二进制，跳过 npm 安装流程',
            '中国用户自动走 herear.cn 镜像加速，安装失败自动降级到 npm',
          ],
          en: [
            'Download Claude Code native binary directly from GCS, skipping npm installation',
            'China users auto-routed to herear.cn mirror, falls back to npm on failure',
          ],
        },
      },
    ],
  },
  {
    version: '0.8.12',
    date: '2026-03-12',
    highlights: {
      zh: ['修复运行时切换模式后权限判断不更新的问题'],
      en: ['Fixed permission mode not updating after runtime mode switch'],
    },
    categories: [
      {
        label: { zh: '修复', en: 'Fixes' },
        items: {
          zh: [
            '修复运行时切换权限模式（如 bypass → plan）后，后台仍按旧模式处理权限请求',
            '新增当前模式指示器，状态栏显示 bypass/code/ask/plan',
            '修复老版本升级后默认模式未正确设为 bypass 的问题',
          ],
          en: [
            'Fixed runtime permission mode switch (e.g. bypass → plan) not reflected in background permission handler',
            'Added current mode indicator to status bar showing bypass/code/ask/plan',
            'Fixed default mode not correctly set to bypass after upgrading from older versions',
          ],
        },
      },
    ],
  },
  {
    version: '0.8.11',
    date: '2026-03-12',
    highlights: {
      zh: ['修复切标签页后聊天记录丢失的严重 Bug'],
      en: ['Fixed critical bug: chat history lost after switching tabs'],
    },
    categories: [
      {
        label: { zh: '修复', en: 'Fixes' },
        items: {
          zh: [
            '修复切标签页后聊天记录丢失 — 后台缓存方法不再创建空快照覆盖真实历史',
            'LRU 缓存淘汰保护正在执行的会话 — CLI 压缩上下文后切回不再只剩末尾几条',
            '空快照安全网 — 检测到空缓存快照时自动回退到磁盘加载完整历史',
          ],
          en: [
            'Fixed chat history loss on tab switch — background cache methods no longer create empty snapshots that overwrite real history',
            'LRU cache eviction protects active streaming sessions — switching back after CLI context compaction no longer shows only last few messages',
            'Empty snapshot safety net — auto-fallback to disk load when detecting empty cache snapshots',
          ],
        },
      },
    ],
  },
  {
    version: '0.8.10',
    date: '2026-03-11',
    highlights: {
      zh: ['CLI 原生二进制检测、Windows Git 解压超时修复'],
      en: ['Native CLI binary detection, Windows Git extraction timeout fix'],
    },
    categories: [
      {
        label: { zh: '修复', en: 'Fixes' },
        items: {
          zh: [
            'CLI 检测优先原生二进制 — ~/.claude/local/claude 优先于 npm 路径，避免 Node.js v22 的 --sdk-url bug',
            'Windows PortableGit 解压超时 — 超时从 120 秒延长至 300 秒，低配机器不再误报失败',
            '下载内容校验 — 检测 CDN 劫持（< 1MB 自动跳到下一个镜像源）',
            '错误分类修正 — 本地解压超时不再被误判为网络错误，不再误提示「需要 VPN」',
            '通知权限 — 不再启动时弹出权限请求，改为首次需要时懒加载',
          ],
          en: [
            'CLI detection prioritizes native binary — ~/.claude/local/claude checked before npm paths, avoiding Node.js v22 --sdk-url bug',
            'Windows PortableGit extraction timeout — Extended from 120s to 300s, preventing false failures on slower machines',
            'Download content validation — Detects CDN hijacking (< 1MB auto-skips to next mirror)',
            'Error classification fix — Local extraction timeout no longer misidentified as network error',
            'Notification permission — Lazy request on first need instead of eager startup prompt',
          ],
        },
      },
    ],
  },
  {
    version: '0.8.9',
    date: '2026-03-11',
    highlights: {
      zh: ['6 项关键 Bug 修复、3 项 UX 改进'],
      en: ['6 critical bug fixes, 3 UX improvements'],
    },
    categories: [
      {
        label: { zh: '新功能', en: 'New' },
        items: {
          zh: [
            '对话完成时推送系统通知（窗口不在前台时自动提醒）',
            '右键菜单「重命名」支持内联编辑（不再弹出系统对话框）',
          ],
          en: [
            'System notification when chat completes (while window is unfocused)',
            'Context menu rename now uses inline editing (no more browser prompt)',
          ],
        },
      },
      {
        label: { zh: '修复', en: 'Fixes' },
        items: {
          zh: [
            'Plan 审批后 CLI 未收到确认响应的问题',
            '交互卡片等待期间误按 Enter 发送消息的问题',
            '后台会话 stderr 漏到前台空闲标签页的问题',
            'CLI 崩溃后交互卡片永久卡住的问题',
            '文件路径标签在气泡中从中间断行的问题',
            '停滞检测误报（改为 120 秒静默检测）',
          ],
          en: [
            'Plan approval not sending CLI confirmation response',
            'Accidental Enter submission while interaction card is pending',
            'Background session stderr leaking into idle foreground tab',
            'Interaction cards stuck permanently after CLI crash',
            'File path chip breaking mid-text in message bubbles',
            'Stall detection false positives (now 120s silence-based)',
          ],
        },
      },
      {
        label: { zh: '改进', en: 'Improved' },
        items: {
          zh: [
            '技能面板按拼音排序',
            '斜杠命令选中项高亮更清晰',
          ],
          en: [
            'Skills panel sorted alphabetically with CJK awareness',
            'Slash command selected item highlight improved',
          ],
        },
      },
    ],
  },
  {
    version: '0.8.8',
    date: '2026-03-09',
    highlights: {
      zh: ['多会话隔离加固，修复 Markdown 渲染兼容性'],
      en: ['Multi-session isolation hardening, Markdown rendering compatibility fix'],
    },
    categories: [
      {
        label: { zh: '修复', en: 'Fixes' },
        items: {
          zh: [
            '多会话隔离 — 修复临时 ID 污染会话列表和进程映射泄漏的问题',
            'Markdown 渲染 — 修复旧版 macOS 上打开聊天可能白屏的问题',
          ],
          en: [
            'Multi-session isolation — Fix temporary ID polluting session list and process mapping leak',
            'Markdown rendering — Fix potential white screen on older macOS when opening chats',
          ],
        },
      },
    ],
  },
  {
    version: '0.8.7',
    date: '2026-03-08',
    highlights: {
      zh: ['新增导出纯对话功能'],
      en: ['New conversation-only export'],
    },
    categories: [
      {
        label: { zh: '新功能', en: 'New' },
        items: {
          zh: [
            '导出纯对话 — 导出 Markdown 时可选择仅导出文字对话，跳过工具调用和空消息',
          ],
          en: [
            'Export conversation only — Export Markdown with text-only option, skipping tool calls and empty messages',
          ],
        },
      },
    ],
  },
  {
    version: '0.8.6',
    date: '2026-03-07',
    highlights: {
      zh: ['多会话稳定性大幅提升，修复 6 个核心 Bug'],
      en: ['Major multi-session stability improvements, 6 core bug fixes'],
    },
    categories: [
      {
        label: { zh: '修复', en: 'Fixes' },
        items: {
          zh: [
            '多会话串窗口 — 修复不同标签页消息串到同一会话的问题',
            '文件监听风暴 — 后台 CLI 操作不再导致界面持续刷新',
            '会话时间显示 — 同一天内的会话显示具体时间而非全部显示「今天」',
            '聊天回退 — 修复回退后旧上下文残留的问题',
            '残留思考状态 — 切换回已完成的会话不再显示「思考中」',
            '添加 API 菜单 — 菜单被底部裁切时自动向上弹出',
          ],
          en: [
            'Multi-session cross-talk — fix messages leaking between tabs',
            'File watcher storm — background CLI no longer causes UI refresh flood',
            'Session timestamps — show HH:mm for same-day sessions instead of all "today"',
            'Rewind failure — fix old context persisting after rewind',
            'Stale thinking state — switching to completed sessions no longer shows "thinking"',
            'AddProvider menu — auto-flip upward when clipped at viewport bottom',
          ],
        },
      },
    ],
  },
  {
    version: '0.8.5',
    date: '2026-03-06',
    highlights: {
      zh: [],
      en: [],
    },
    categories: [
      {
        label: { zh: '新功能', en: 'New' },
        items: {
          zh: [
            '文件右键分享 — macOS 右键菜单新增「分享…」和「分享到微信」',
            '用户头像与昵称 — 设置中自定义头像和显示名，聊天气泡右侧展示',
            '自部署 CLI 注入 shell PATH — macOS/Linux 安装后自动写入 ~/.zshrc 等，终端可直接用 claude',
            '隐藏文件开关 — 文件树标题栏新增眼睛按钮，一键切换隐藏/显示 dotfiles',
            '更新日志分类 — 「更新说明」弹窗按新功能/修复/改进分组展示',
          ],
          en: [
            'File sharing — "Share..." and "Share to WeChat" added to macOS file context menu',
            'User avatar & display name — Customize in Settings, shown next to chat bubbles',
            'Self-deployed CLI injects shell PATH — macOS/Linux auto-writes to ~/.zshrc etc., claude works from terminal',
            'Hidden files toggle — Eye button in file tree header to show/hide dotfiles',
            'Categorized changelog — "What\'s New" modal groups entries by type',
          ],
        },
      },
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: [
            'CLI 发现优先级 — 系统已安装的 CLI 优先于自部署版本，登录状态正确共享',
            '第三方 API 模型拦截 — 未配置模型映射时阻止发送并提示，不再把原始模型名发给第三方报错',
            '继承配置修复 — 不再意外清除系统环境变量，继承模式正常使用系统 API Key',
            '标题生成适配第三方 — 使用 provider 映射的 haiku 模型，无映射时静默跳过',
            '多窗口串消息 — 切换对话窗口后，后台会话的回复不再串到前台窗口',
            'Windows 安装修复 — 缺少 git-bash 时重装不再被"已检测到 CLI"短路，正确走修复路径',
            'Windows CLI 调用统一 — run_claude_command 和 check_claude_auth 统一 cmd /C 包装，.cmd/.bat 不再启动失败',
            'Windows timeout 回退 — CLI 超时后正确回退到 PATH / Claude Desktop / scoop / nvm 等候选',
            'Unix 终端可用 — 自部署 Node 安装后自动写入 shell PATH，终端里 claude 命令不再找不到',
            '终端登录路径安全 — open_terminal_login 对 CLI 路径做 shell quoting，带空格路径不再报错',
          ],
          en: [
            'CLI discovery priority — System-installed CLI takes precedence over self-deployed, login state shared correctly',
            'Third-party API model interception — Blocks send when model mapping is missing, prevents raw model name errors',
            'Inherit config fix — No longer clears system env vars, inherited mode correctly uses system API Key',
            'Title generation adapts to providers — Uses provider-mapped haiku model, silently skips when unmapped',
            'Cross-tab message leaking — Background session responses no longer bleed into the active tab',
            'Windows install fix — Missing git-bash no longer short-circuits reinstall when CLI is already detected',
            'Windows CLI invocation — run_claude_command and check_claude_auth now consistently use cmd /C wrapper for .cmd/.bat',
            'Windows timeout fallback — CLI timeout correctly falls back to PATH / Claude Desktop / scoop / nvm candidates',
            'Unix terminal CLI — Self-deployed Node install now writes shell PATH, claude command works from terminal',
            'Terminal login path safety — open_terminal_login applies shell quoting, paths with spaces no longer break',
          ],
        },
      },
      {
        label: { zh: '改进', en: 'Improved' },
        items: {
          zh: [
            '连接测试三步走 — 分步检测连通性、Key 有效性、模型可用性，精准定位问题',
            '文件夹图标主题色 — 更容易区分文件和文件夹',
            '简化模式选择 — 默认 Bypass 模式，高级用户可通过 /ask /plan /code /bypass 切换',
          ],
          en: [
            'Three-step connection test — Separately checks connectivity, auth, and model availability for precise diagnostics',
            'Folder icons use accent color — Better distinction between files and folders',
            'Simplified mode selection — Defaults to Bypass mode, power users switch via /ask /plan /code /bypass commands',
          ],
        },
      },
    ],
  },
  {
    version: '0.8.2',
    date: '2026-03-04',
    highlights: {
      zh: [
        '修复长对话卡死 — 超过 5 轮对话后流式输出不再卡住，重大性能优化',
        '修复权限弹窗反复弹出 — 点过「稍后」后不会再次弹出',
        '修复内存泄漏 — 面板拖拽时事件监听器不再累积（感谢 @qs858053851-wq 反馈）',
        '切换对话时输入框内容正确跟随切换',
        '修复中文输入法偶发丢失焦点',
        '新增/导入 API 后自动生效，无需手动选择',
        'VPN 关闭后 API 自动切换直连，无需手动操作',
        '双版本体系 — 一套代码支持 Black Box Preview 内测版和 Black Box 稳定版',
      ],
      en: [
        'Fix long conversation freeze — Streaming no longer stalls after 5+ turns, major performance improvement',
        'Fix permission dialog re-appearing — Dismissal is now persisted',
        'Fix memory leak — Panel resize listeners no longer accumulate (thanks @qs858053851-wq)',
        'Input content follows tab switch correctly',
        'Fix CJK IME occasionally losing focus',
        'New/imported API providers auto-activate',
        'Auto-switch to direct connection when VPN is off',
        'Dual-edition system — One codebase supports Black Box Preview and Black Box',
      ],
    },
  },
  {
    version: '0.8.1',
    date: '2026-03-02',
    highlights: {
      zh: [
        'AI 头像自定义 — 设置里可以换 AI 聊天头像了，支持裁剪和缩放',
        '安全加固 — 修复路径穿越、权限默认值、进程清理、XSS 等 8 项安全问题',
        '稳定性提升 — 流消息错误兜底、事件监听器泄漏清理、缓存 LRU 淘汰',
        '自动压缩不再卡死 — /compact 处理卡片现在能正确完成，超时也有兜底',
        '系统消息不再丢失 — CLI 发的错误通知现在会显示在聊天里',
        'CLI 检测更可靠 — 统一验证可执行文件有效性，设置页面状态与安装向导对齐',
        '文件路径识别更精准 — 不再把 API 路径等普通文字错认成文件链接',
        '长时间思考不再卡住 — 修复了 AI 深度思考时消息重复堆积、文字回复被淹没的问题',
        '无限制模式不再卡死 — 修复了无限制模式下 AI 偶尔发消息后没有回复的问题',
        '首句回复更快 — 跳过不必要的 MCP 服务器加载，冷启动速度大幅提升',
      ],
      en: [
        'Custom AI avatar — Set a custom chat avatar in Settings with crop & zoom support',
        'Security hardening — Fixed 8 security issues: path traversal, permission defaults, XSS, and more',
        'Stability improvements — Stream error boundary, event listener leak cleanup, cache LRU eviction',
        'Auto-compact no longer gets stuck — /compact processing card now completes properly with timeout fallback',
        'System messages no longer silently dropped — CLI error notifications now appear in chat',
        'More reliable CLI detection — Validates executable integrity across all discovery paths',
        'Smarter file path detection — API endpoints and other non-file text no longer turn into clickable chips',
        'Extended thinking no longer gets stuck — Fixed duplicate thinking messages that buried text responses during long reasoning sessions',
        'Bypass mode no longer hangs — Fixed intermittent "thinking forever" bug where the CLI would freeze waiting for a response that never came',
        'Faster first response — Skip unnecessary MCP server loading for significantly faster cold start',
      ],
    },
  },
  {
    version: '0.8.0',
    date: '2026-03-01',
    highlights: {
      zh: [
        '全模块重构 — 底层架构全面升级，运行更稳定、响应更快',
        '权限交互升级 — 用 Claude 原生控制协议替代旧方案，权限弹窗更可靠',
        '会话列表大改 — 支持置顶、归档、撤销删除、批量操作、日期分组、运行中筛选',
        '设置面板重做 — 分标签页布局，API 提供商管理更直观，预设一键添加',
        '文件回退改用 CLI 检查点 — 不再依赖自建快照，回退更准确',
        '修复代理环境变量丢失 — 安装版应用现在能正确走代理连接 API',
        '更新检测优先走 GitHub — 国内不可达时自动降级到 Gitee',
      ],
      en: [
        'Full module refactor — Complete architecture overhaul for better stability and responsiveness',
        'Permission handling upgrade — Native SDK control protocol replaces old regex-based approach',
        'Session list revamp — Pin, archive, undo delete, batch ops, date groups, running filter',
        'Settings panel redesign — Tabbed layout, intuitive provider management, one-click presets',
        'File rewind uses CLI checkpoints — More accurate rollback without custom snapshot system',
        'Fix proxy env vars not inherited — Installed app now correctly uses proxy to reach API',
        'Updater checks GitHub first — Auto-falls back to Gitee when GitHub is unreachable',
      ],
    },
  },
  {
    version: '0.6.16',
    date: '2026-02-27',
    highlights: {
      zh: [
        '修复快速新建任务路径解析 — + 按钮和右键「新建任务」不再因 ~ 路径未展开而报错',
        '自动更新改为用户确认制 — 检测到新版本后仅显示提示，用户点击后才下载更新',
      ],
      en: [
        'Fix quick new session path resolution — "+" button and "New Task" no longer fail due to unexpanded ~ path',
        'Auto-update requires user confirmation — Updates are detected but only downloaded after user clicks',
      ],
    },
  },
  {
    version: '0.6.15',
    date: '2026-02-27',
    highlights: {
      zh: [
        '修复流式响应卡在「思考中」(TK-322) — 中间消息不再意外清空流式文本状态，解决偶发的 UI 卡死问题',
        '项目名样式优化 — 更大更粗的字体 + accent 色箭头，项目与会话层级一目了然',
        '技能面板右键菜单 (TK-312) — 右键技能卡片直接弹出操作菜单',
        '最近项目列表自动淘汰 (TK-321) — 只保留最近 4 个项目，旧条目自动替换',
        '项目级右键菜单 — 右键项目标题可新建任务或删除全部任务，hover 时有 + 按钮快捷创建',
      ],
      en: [
        'Fix streaming stuck in "thinking" (TK-322) — Intermediate messages no longer wipe streaming text state, fixing intermittent UI freeze',
        'Project header styling — Larger bold text + accent chevrons for clear visual hierarchy',
        'Skill panel right-click menu (TK-312) — Right-click skill cards to open context menu',
        'Recent projects auto-limit (TK-321) — Keeps only 4 most recent projects, auto-replacing older entries',
        'Project-level context menu — Right-click project header for new task / delete all, plus hover + button',
      ],
    },
  },
  {
    version: '0.6.14',
    date: '2026-02-26',
    highlights: {
      zh: [
        '修复会话重载技能内容泄露 — 重新加载历史会话时，技能内容不再被误显示为用户消息',
        '修复 Windows 图标模糊 — 重新生成多层 ICO（16-256px），任务栏图标清晰显示',
        '修复 API Key 清空未删除 — 清空 Key 后真正从磁盘删除密钥文件',
        '文件树深度 3→8 + 忽略列表 6→15 项 — 深层文件可见，常见构建目录自动忽略',
        '文件引用统一胶囊样式 — 助手消息和用户气泡中的文件路径均为可点击胶囊标签',
        '裸文件名识别 — CLAUDE.md、package.json 等常见文件名也能被识别为可点击文件',
        '修复 URL 被误识别为文件路径的问题',
      ],
      en: [
        'Fix session reload skill content leak — Skill content no longer appears as user bubbles on reload',
        'Fix Windows icon blurry — Regenerated multi-layer ICO (16-256px) for crisp taskbar display',
        'Fix API Key not deleted on clear — Clearing key now actually removes it from disk',
        'File tree depth 3→8 + ignore list 6→15 — Deep files visible, common build dirs auto-ignored',
        'Unified file reference chip style — File paths in both assistant and user messages are clickable chips',
        'Bare filename detection — CLAUDE.md, package.json etc. now recognized as clickable files',
        'Fix URLs being misidentified as file paths',
      ],
    },
  },
  {
    version: '0.6.13',
    date: '2026-02-26',
    highlights: {
      zh: [
        '修复应用图标白边 — 重新生成全平台图标，消除 Dock/任务栏中的白色边框',
        'Release 构建开启 DevTools — 正式版可通过 Cmd+Option+I / Ctrl+Shift+I 打开开发者工具',
        '仓库清理 — 移除过时的开发文件，精简仓库体积',
      ],
      en: [
        'Fix app icon white border — Regenerated all platform icons, eliminating white borders in Dock/taskbar',
        'DevTools in release builds — Open Chrome DevTools via Cmd+Option+I / Ctrl+Shift+I in production',
        'Repo cleanup — Removed obsolete development files, reduced repository size',
      ],
    },
  },
  {
    version: '0.6.12',
    date: '2026-02-26',
    highlights: {
      zh: [
        '修复文件树深度 — 三级、四级文件/文件夹现在能正确显示（递归深度 3→5）',
        '修复拖拽误关闭 — 设置面板和更新日志弹窗不再因拖拽鼠标到外部而关闭',
        '构建脚本安全加固 — 移除硬编码凭证，改用 .env 环境变量',
        '文件变更标记统一绿色 — 所有变更指示器使用一致的绿色样式',
        '文件树工具栏简化 — 清理标记和刷新合并为一个按钮',
      ],
      en: [
        'Fix file tree depth — 3rd/4th level files now display correctly (depth 3→5)',
        'Fix drag-close bug — Settings panel and changelog modal no longer close on drag outside',
        'Build script security — Removed hardcoded credentials, now uses .env variables',
        'File change indicators unified green — All change markers use consistent success green',
        'File tree toolbar simplified — Clear markers and refresh merged into one button',
      ],
    },
  },
  {
    version: '0.6.11',
    date: '2026-02-26',
    highlights: {
      zh: [
        '修复 Windows npm EPERM — 使用应用内缓存目录，避免杀毒软件锁定导致安装失败',
        '修复 Windows PowerShell 找不到 claude — 始终安装到受控目录，确保 PATH 生效',
        '修复 macOS Xcode CLT 弹窗 — 无 CLT 时不再触发安装对话框，自动扫描 Homebrew/MacPorts',
        '修复误导性错误提示 — EPERM 错误不再显示「需要 VPN」，改为正确的权限提示',
      ],
      en: [
        'Fix Windows npm EPERM — Uses app-local cache dir, avoids antivirus-locked cache failures',
        'Fix Windows PowerShell can\'t find claude — Always installs to controlled dir, ensures PATH works',
        'Fix macOS Xcode CLT popup — No longer triggers install dialog without CLT, scans Homebrew/MacPorts',
        'Fix misleading error hint — EPERM errors now show "permission denied" instead of "need VPN"',
      ],
    },
  },
  {
    version: '0.6.10',
    date: '2026-02-26',
    highlights: {
      zh: [
        'API 配置导入导出 — 第三方 API 配置一键 JSON 导入导出，面向培训场景：讲师导出，学员一键导入',
        '静默后台更新 — 检测到新版本自动后台下载，完成后显示「重启」按钮',
        'Gitee 下载源 — 更新下载现在走 Gitee，国内用户无梯子也能完整更新',
        'Node.js 检测增强 — 检测 nvm/volta/fnm 安装的 Node.js，避免重复下载',
      ],
      en: [
        'API config import/export — One-click JSON import/export for third-party API settings, designed for onboarding',
        'Silent background updates — Automatically downloads updates in the background, shows restart button when ready',
        'Gitee download source — Updates now download from Gitee, domestic users can update without VPN',
        'Node.js detection — Detects nvm/volta/fnm-installed Node.js on all platforms, prevents unnecessary downloads',
      ],
    },
  },
  {
    version: '0.6.9',
    date: '2026-02-25',
    highlights: {
      zh: [
        '国内网络优化 — 移除 GCS 下载路径（GFW 屏蔽），自动检测网络环境，国内镜像优先（npmmirror CDN、华为云）',
        'Node.js 镜像地址修复 — 修复导致国内用户 CLI 安装失败的 404 镜像地址',
        'Gitee 更新检测 — 新增 Gitee 作为首选更新检测端点，国内用户无需梯子即可检测更新',
        '响应超时检测 3 分钟 → 5 分钟 — 避免接入 API 时的误报',
      ],
      en: [
        'China network optimization — Removed GCS download path (blocked by GFW), auto-detects network environment, China mirrors prioritized (npmmirror CDN, Huawei Cloud)',
        'Node.js mirror URL fix — Fixed 404 mirror URL that caused CLI installation failures for domestic users',
        'Gitee updater endpoint — Added Gitee as primary update detection source, domestic users can check updates without VPN',
        'Stall detection timeout 3min → 5min — Prevents false positives for API-connected users',
      ],
    },
  },
  {
    version: '0.6.8',
    date: '2026-02-25',
    highlights: {
      zh: [
        'macOS/Linux CLI 二进制损坏修复 — 检测到 Mach-O 魔术字节无效时自动删除坏文件并重试，GCS 下载后增加 --version 验证',
        '操作确认弹窗 — 重新安装 CLI 和关闭窗口现在需要用户确认，防止误操作',
      ],
      en: [
        'macOS/Linux malformed binary fix — Auto-deletes corrupt CLI binaries (invalid Mach-O magic bytes) and retries, GCS downloads now validated with --version',
        'Confirmation dialogs — Reinstall CLI and window close now require user confirmation to prevent accidental operations',
      ],
    },
  },
  {
    version: '0.6.7',
    date: '2026-02-25',
    highlights: {
      zh: [
        'macOS/Linux CLI 权限修复 — 执行权限丢失时自动 chmod +x 并重试',
        'API Key 切换生效 — 换 Key 后正确终止旧进程并用新 Key 重建会话',
        'CLI 配置覆盖修复 — 阻止 ~/.claude/settings.json 静默覆盖应用注入的 API 端点',
        '损坏凭证自动清理 — 无法解密的 credentials.enc 自动删除，用户可重新输入',
      ],
      en: [
        'macOS/Linux CLI permission fix — Auto chmod +x and retry on execute permission loss',
        'API Key switch fix — Changing keys now correctly kills old process and rebuilds session',
        'CLI config override fix — Prevents ~/.claude/settings.json from silently overriding injected API endpoints',
        'Corrupted credentials auto-cleanup — Unreadable credentials.enc auto-deleted for clean re-entry',
      ],
    },
  },
  {
    version: '0.6.6',
    date: '2026-02-25',
    highlights: {
      zh: [
        '会话中模型热切换 — 切换模型后自动终止旧进程并用新模型 resume 重启，不再静默忽略',
        '模型切换标签 — 切换时对话流立即显示居中标签（如 Sonnet 4.6 → Opus 4.6）',
      ],
      en: [
        'Mid-session model hot-swap — Switching models now kills the old process and resumes with the new model automatically',
        'Model switch indicator — A centered pill tag appears instantly in the chat flow when switching models',
      ],
    },
  },
  {
    version: '0.6.5',
    date: '2026-02-25',
    highlights: {
      zh: [
        '文件拖拽统一 — 文件树拖拽和系统拖入文件统一走对话框内联 chip，不再有两个触发区域',
        '默认工作模式改为 Bypass — 新安装默认使用 bypass 模式，减少权限弹窗干扰',
        '默认思考改为中等 — 新安装默认 Medium 思考深度，平衡速度与质量',
        '子代理渲染崩溃修复 — 修复子代理启动时 React error #31（content block 对象泄漏到 JSX），涉及 4 处渲染路径',
        'macOS 代码签名 — 重新启用 CI 签名 + 公证，新增 entitlements.plist，安装不再报「文件已损坏」',
      ],
      en: [
        'Unified file drag-drop — Tree drag and OS file drop both use inline chips in dialog, no more dual trigger zones',
        'Default mode: Bypass — New installs default to bypass mode, fewer permission popups',
        'Default thinking: Medium — New installs use medium thinking depth, balancing speed and quality',
        'Sub-agent render crash fix — Fixed React error #31 when sub-agent starts (content block objects leaking into JSX), 4 render paths patched',
        'macOS code signing — Re-enabled CI signing + notarization with entitlements.plist, no more "file is damaged" on install',
      ],
    },
  },
  {
    version: '0.6.4',
    date: '2026-02-25',
    highlights: {
      zh: [
        'Windows CMD 窗口彻底消除 — 补全最后 4 处遗漏：git 操作、CLI 安装验证、VSCode 打开、Explorer 定位',
        'CLI 终端可用 — 安装后自动设置 CLAUDE_CODE_GIT_BASH_PATH 用户环境变量，PowerShell/CMD 直接运行 claude 不再报错',
        '安装流程防卡死 — 所有安装子进程添加 stdin 隔离 + 超时保护（版本检查 10s / npm 安装 5min / 解压 2min），不再出现 CMD 卡住',
      ],
      en: [
        'Windows CMD window fully eliminated — Fixed last 4 missing spots: git ops, CLI install validation, VSCode open, Explorer reveal',
        'CLI works from terminal — Auto-sets CLAUDE_CODE_GIT_BASH_PATH user env var after install, running claude from PowerShell/CMD works',
        'Install flow hang protection — All install subprocesses now have stdin isolation + timeouts (version checks 10s / npm install 5min / extraction 2min), no more stuck CMD windows',
      ],
    },
  },
  {
    version: '0.6.3',
    date: '2026-02-24',
    highlights: {
      zh: [
        '自动更新 — 每 10 分钟后台检查新版本，顶栏右上角出现更新按钮，一键下载安装重启',
        'API 设置持久化 — 凭证和 API 配置备份到 ~/.blackbox/，Windows 更新后不再丢失',
        'Windows 命令行窗口消除 — 所有后台进程添加 CREATE_NO_WINDOW，彻底消灭闪烁的 CMD 窗口',
        '权限循环修复 — 权限响应改用原始 stdin 通道，GUI 始终跳过 CLI 权限提示',
        'CLI 路径搜索修复 — Windows 上跳过无扩展名的 JS 脚本，避免 error 193',
      ],
      en: [
        'Auto-update — Background check every 10 min, update button appears in top bar for one-click download & restart',
        'API settings persistence — Credentials and API config backed up to ~/.blackbox/, survives Windows updates',
        'Windows CMD window elimination — All background processes use CREATE_NO_WINDOW, no more flashing CMD windows',
        'Permission loop fix — Permission responses now use raw stdin; GUI always skips CLI permission prompts',
        'CLI path search fix — Skips extensionless JS scripts on Windows, preventing error 193',
      ],
    },
  },
  {
    version: '0.6.2',
    date: '2026-02-24',
    highlights: {
      zh: [
        'Windows CLI 启动修复 — 修复 GCS 下载的 claude.exe 无效导致 error 193 的问题',
        'CLI 检测优化 — Windows 优先使用 npm 安装的 claude.cmd（更可靠），GCS 二进制作为后备',
        '自动清理机制 — 检测到无效二进制时自动删除并切换到可用版本',
      ],
      en: [
        'Windows CLI launch fix — Fixed error 193 caused by invalid GCS-downloaded claude.exe',
        'CLI detection improved — Windows now prefers npm-installed claude.cmd (more reliable), GCS binary as fallback',
        'Auto-cleanup — Automatically removes invalid binaries and switches to working alternatives',
      ],
    },
  },
  {
    version: '0.6.1',
    date: '2026-02-24',
    highlights: {
      zh: [
        'Windows Git Bash 自动安装 — 首次安装 CLI 时自动下载并部署 PortableGit，无需手动安装 Git for Windows',
        'Git 下载三源降级 — npmmirror → 华为云 → GitHub，15 秒连接超时快速切换，国内用户无感',
        '安装流程优化 — 移除手动「下载 Git」步骤，整个环境部署全自动（Git → Node.js → CLI）',
        'CLI 启动预检增强 — 自动注入 CLAUDE_CODE_GIT_BASH_PATH，找不到 Git 时给出明确错误提示',
      ],
      en: [
        'Windows Git Bash auto-install — PortableGit is automatically downloaded and deployed during CLI setup, no manual Git installation needed',
        'Git download with 3-source fallback — npmmirror → Huawei Cloud → GitHub, 15s connect timeout for fast failover',
        'Streamlined setup — Removed manual "Download Git" step, entire environment deployment is fully automatic (Git → Node.js → CLI)',
        'CLI pre-flight enhancement — Auto-injects CLAUDE_CODE_GIT_BASH_PATH, clear error message when Git is missing',
      ],
    },
  },
  {
    version: '0.6.0',
    date: '2026-02-24',
    highlights: {
      zh: [
        'Node.js 本地部署 — 首次启动若无 npm，自动下载 Node.js LTS v22 到应用目录，无需管理员权限',
        '三层 CLI 安装降级 — GCS 直接下载 → npm 安装 → 自动部署 Node.js 后 npm 安装，每层失败优雅降级',
        '国内镜像支持 — Node.js 和 npm 包自动切换 npmmirror 国内镜像，防火墙内无需 VPN',
        '防火墙错误检测 — 网络超时、DNS 失败等错误显示友好提示，建议使用代理',
        'Windows PATH 自动配置 — 安装后自动添加 cli/、node/bin、npm-global/bin 到用户 PATH',
      ],
      en: [
        'Node.js local deployment — Auto-downloads Node.js LTS v22 on first launch if npm is missing, no admin required',
        'Three-tier CLI install fallback — GCS direct download → npm install → auto-deploy Node.js + npm, graceful fallback',
        'China mirror support — Node.js and npm packages auto-switch to npmmirror when official sources are unreachable',
        'Firewall error detection — Friendly hints for network timeout, DNS failure, suggesting VPN or proxy',
        'Windows PATH auto-config — Adds cli/, node/bin, npm-global/bin to user PATH after installation',
      ],
    },
  },
  {
    version: '0.5.6',
    date: '2026-02-24',
    highlights: {
      zh: [
        'Tiptap 富文本编辑器 — 输入框升级为 Tiptap 编辑器，支持行内文件标签、更好的光标控制',
        '文件拖拽内联标签 — 拖入文件显示为可删除的行内标签，替代旧的文件列表样式',
        '默认模型切换 Sonnet 4.6 — 新安装默认使用 claude-sonnet-4-6，性价比更高',
        'Windows CLI PATH 修复 — 修复 CLI 安装后 PATH 未正确写入导致的启动失败问题',
        'Thinking 默认关闭 — 新安装默认关闭 Thinking，按需开启',
      ],
      en: [
        'Tiptap rich text editor — Input bar upgraded to Tiptap with inline file chips and better cursor control',
        'File drag-and-drop inline chips — Dragged files appear as removable inline chips instead of a list',
        'Default model switched to Sonnet 4.6 — New installs default to claude-sonnet-4-6 for better cost efficiency',
        'Windows CLI PATH fix — Fixed PATH not written correctly after CLI installation causing launch failures',
        'Thinking off by default — New installs start with Thinking disabled, enable as needed',
      ],
    },
  },
  {
    version: '0.5.5',
    date: '2026-02-24',
    highlights: {
      zh: [
        'Thinking 五档选择器 — Off / Low / Med / High / Max 替代 on/off 开关，通过 CLI 原生 effort level 控制思考深度',
        'Thinking 关闭修复 — 修复「关闭思考仍在思考」的 bug，现在显式传 alwaysThinkingEnabled:false',
        'Output Token 上限提升 — 注入 CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000，单次回复上限翻倍',
        'Token 预警 + Auto-compact — 上下文超 120K 琥珀色警告；超 160K 自动压缩，每会话至多一次',
        '会话 Token 累计计数 — 侧栏显示整个任务的总 Token 消耗，不再只显示单轮数据',
        '会话断点续传修复 — Stop 按钮泄漏、lastActiveSessionId 持久化、stall 检测、onSessionExit 备用通道等 6 项修复',
        'Plan 审批统一 — Code 模式透明处理 Plan 工具（自动恢复）；三种模式（Code/Plan/Bypass）统一审批流程',
        '权限请求修复 — 修复 ANSI 转义码导致权限弹窗不显示的问题，新增 Holding 机制：弹窗等待期间暂停生成状态',
        '对话框 UI 优化 — 用户气泡字体缩小、附件卡片化、一键复制、AI 输出路径可点击打开',
        'Agent 监控浮动面板 — 代理状态从侧边栏移至顶栏浮动按钮，活跃时脉冲徽章提示，实时追踪 thinking/writing/tool 阶段',
        'API 模块改造 — 顶栏显示当前 API 通路；API Key 用 ref 追踪遮罩状态，修复定时器泄漏',
        '文件管理器主题适配 — 变更标记（A/M/D）改用主题变量，颜色随主题切换',
      ],
      en: [
        'Thinking 5-level selector — Off / Low / Med / High / Max replaces on/off toggle, using CLI native effort level',
        'Thinking disable fix — Fixed "thinking still active when disabled" bug with explicit alwaysThinkingEnabled:false',
        'Output token cap raised — Injects CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000, doubling per-turn output limit',
        'Token warning + Auto-compact — Amber alert at 120K context; auto-compact at 160K, fires at most once per session',
        'Session token counter — Sidebar shows cumulative token usage across all turns, not just per-turn data',
        'Session resume fixes — Stop button leak, lastActiveSessionId persistence, stall detection, onSessionExit backup, and 6 total fixes',
        'Unified plan approval — Code mode transparently handles plan tools with auto-recovery; consistent approval flow across Code/Plan/Bypass modes',
        'Permission request fix — ANSI escape codes stripped before regex matching; holding mechanism pauses generation while awaiting user approval',
        'Chat UI polish — Smaller user bubbles, file attachment cards, one-click copy, clickable file paths in AI output',
        'Agent monitoring float — Agent status moved from sidebar to floating top-bar button with pulse badge, real-time phase tracking',
        'API module revamp — Top bar shows active API route; API Key uses ref-based mask tracking, timer leak fix',
        'File explorer theme sync — Change badges (A/M/D) use theme variables, colors follow theme switching',
      ],
    },
  },
  {
    version: '0.5.4',
    date: '2026-02-21',
    highlights: {
      zh: [
        '第三方 API 切换 (TK-303) — 设置面板三种模式：继承系统配置 / 官方 API / 自定义端点 + 加密密钥 + 模型映射',
        '连接测试 & Thinking 签名自动重试 — 一键测试连通性，切换提供商后自动重发',
        '一键回到底部按钮 + 设置面板 CLI 管理 + 过期预热会话检测',
        'ANSI 转义码过滤、子代理缩进、删除到回收站等 9 项修复',
      ],
      en: [
        'Third-party API switching (TK-303) — 3 modes: Inherit / Official / Custom endpoint + encrypted key + model mapping',
        'Connection test & thinking signature auto-retry — One-click test, auto re-send on provider switch',
        'Scroll-to-bottom button + CLI management in Settings + stale pre-warm detection',
        'ANSI escape stripping, sub-agent indentation, trash-based delete, and 9 other fixes',
      ],
    },
  },
  {
    version: '0.5.3',
    date: '2026-02-21',
    highlights: {
      zh: [
        'Plan 模式退出修复 (TK-306) — 批准后自动切换 code 模式重启会话，Claude 能正常执行工具',
        '新增 sendRawStdin 原始输入通道 — 交互式审批不再用 NDJSON 包装',
        'AskUserQuestion 表单去重 — 修复重新投递导致的重复问题',
      ],
      en: [
        'Plan mode exit fix (TK-306) — Approve & Execute now restarts session in code mode, Claude can execute tools',
        'Raw stdin for interactive approvals — No NDJSON wrapping for y/n prompts',
        'AskUserQuestion dedup — Fixed re-delivery causing duplicate forms',
      ],
    },
  },
  {
    version: '0.5.1',
    date: '2026-02-20',
    highlights: {
      zh: [
        '代码语法高亮配色优化 — 独立 --syntax-* 变量，8 套主题专属配色，不再与语义色撞色',
        'CLI 直接下载安装 — Rust HTTP 从 Anthropic CDN 流式下载，无需 npm/curl/PowerShell',
        'Plan 面板磨砂玻璃浮动 — 背景模糊 + 圆角 + 阴影，不再挤压主聊天区',
        'Windows CLI 启动修复 — 修复 npm 安装时错误 193（claude.cmd 回退）',
      ],
      en: [
        'Syntax highlighting — Dedicated --syntax-* variables, 8 theme-specific palettes',
        'CLI direct download — Rust HTTP streaming from Anthropic CDN, no npm/curl/PowerShell needed',
        'Plan panel glassmorphism — Floating overlay with backdrop blur, rounded corners, shadow',
        'Windows CLI fix — Error 193 resolved with claude.cmd fallback for npm installs',
      ],
    },
  },
  {
    version: '0.5.0',
    date: '2026-02-20',
    highlights: {
      zh: [
        'Markdown 图片预览修复 — 本地文件通过 Rust 桥接加载，支持点击放大',
        'Plan Mode 退出修复 — 修复用户确认后面板卡死的问题',
        '/compact 成本信息内置 — Cost/Duration/Turns 显示在命令卡片内',
        '计划面板重构 — 从顶部弹出改为右侧栏，按钮移至输入工具栏',
        'Thinking 流式输出 — 实时显示 AI 思考过程',
        'AskUserQuestion 修复 — 表单去重、Unicode 渲染、跳过状态修复',
        '设置面板新增「查看更新内容」入口',
        '18 项 Bug 修复与体验优化',
      ],
      en: [
        'Markdown image preview fix — Local files loaded via Rust bridge with zoom support',
        'Plan Mode exit fix — Resolved stuck panel after user confirmation',
        '/compact cost info — Cost/Duration/Turns shown inside command card',
        'Plan panel redesign — Right sidebar with toggle in input toolbar',
        'Thinking streaming — Real-time AI thinking process display',
        'AskUserQuestion fixes — Form dedup, Unicode rendering, skip state',
        'Settings panel: "What\'s New" button to view release notes',
        '18 bug fixes and UX improvements',
      ],
    },
  },
  {
    version: '0.4.5',
    date: '2026-02-20',
    highlights: {
      zh: [
        '启动时自动检测更新，有新版本时设置按钮显示绿点提示',
        '更新后首次启动展示更新内容弹窗',
      ],
      en: [
        'Auto-check for updates on startup with green dot notification',
        'Show changelog modal after updating to a new version',
      ],
    },
  },
  {
    version: '0.4.4',
    date: '2026-02-20',
    highlights: {
      zh: [
        'Windows CLI 检测 — 自动检测 Windows 上的 Claude CLI 安装路径',
        '跨平台路径处理 — 兼容 / 和 \\ 分隔符',
        'Token 用量显示 — 侧栏显示输入/输出 token 数量',
        'YAML Frontmatter 渲染 — 文件预览中以独立样式块展示',
        '滚动条样式优化 — 统一细滚动条，主题色适配',
      ],
      en: [
        'Windows CLI Detection — Auto-detect Claude CLI on Windows',
        'Cross-platform Path Handling — Support both / and \\\\ separators',
        'Token Usage Display — Sidebar shows input/output token counts',
        'YAML Frontmatter Preview — Styled metadata block in file preview',
        'Scrollbar Styling — Thin theme-aware scrollbars',
      ],
    },
  },
  {
    version: '0.4.3',
    date: '2026-02-19',
    highlights: {
      zh: [
        '历史附件显示修复 — 历史对话中的附加文件显示为卡片样式，不再是原始路径文本',
      ],
      en: [
        'History attachment display fix — File attachments in historical sessions render as styled chips instead of raw paths',
      ],
    },
  },
  {
    version: '0.4.2',
    date: '2026-02-19',
    highlights: {
      zh: [
        '会话切换缓存修复 — 修复运行中会话点击「新任务」后聊天记录丢失',
        '长消息折叠 — 超过 12 行的用户消息默认折叠，可点击展开',
        '输入框自动增高 — 随内容自动增高，最大到窗口高度的一半',
      ],
      en: [
        'Session switch cache fix — Fixed chat history disappearing when clicking "New Task" during active session',
        'Long message collapse — User messages longer than 12 lines collapse by default with expand toggle',
        'Auto-expanding input — Chat input grows up to 50% of window height',
      ],
    },
  },
  {
    version: '0.4.1',
    date: '2026-02-19',
    highlights: {
      zh: [
        '中文路径解码修复 — 修复包含中文字符的项目路径被错误解码，导致文件树为空和会话分组异常',
      ],
      en: [
        'CJK path decoding fix — Fixed project paths with Chinese characters being corrupted, causing empty file tree',
      ],
    },
  },
  {
    version: '0.4.0',
    date: '2026-02-19',
    highlights: {
      zh: [
        '文件右键菜单 — 复制路径、拷贝文件、粘贴、重命名、删除、插入到聊天',
        '文件树拖拽到聊天 — 从文件树拖拽文件直接附加到对话输入框',
        '模式选择器下拉 — Code/Ask/Plan/Bypass 模式紧凑下拉菜单',
        '编辑器自动折行 — 长行自动换行，编辑和只读模式均生效',
        '性能优化 — MessageBubble/MarkdownRenderer memo 化，流式更新从 3 次 set 合并为 1 次',
      ],
      en: [
        'File context menu — Copy Path, Copy File, Paste, Rename, Delete, Insert to Chat',
        'File tree drag to chat — Drag files from file tree directly into chat input',
        'Mode selector dropdown — Compact dropdown for Code/Ask/Plan/Bypass modes',
        'Editor word wrap — Long lines auto-wrap in both edit and read-only mode',
        'Performance — MessageBubble/MarkdownRenderer memoized, streaming updates merged from 3 to 1 set() call',
      ],
    },
  },
  {
    version: '0.3.0',
    date: '2026-02-19',
    highlights: {
      zh: [
        '应用内更新 — 设置面板检查更新、下载进度条、一键重启，Ed25519 签名安全分发',
        '深度思考开关 — 输入工具栏新增 Think 按钮，启用后进入深度思考模式',
        'Windows 平台适配 — 快捷键提示、文件管理器名称、路径格式全面适配 Windows',
        '四套新主题 — 黑/蓝/橙/绿，移除毛玻璃效果，采用 Apple Squircle 圆角',
      ],
      en: [
        'In-app update — Check, download with progress bar, one-click restart, Ed25519 signed distribution',
        'Extended thinking toggle — Think button in input toolbar for deep reasoning mode',
        'Windows adaptation — Keyboard hints, file manager names, path formats adapted for Windows',
        'Four new themes — Black/Blue/Orange/Green, removed glass effects, Apple squircle corners',
      ],
    },
  },
  {
    version: '0.2.1',
    date: '2026-02-19',
    highlights: {
      zh: [
        '模型 ID 更新 — claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 + localStorage 自动迁移',
        '新建任务流程优化 — 侧栏按钮导航至 WelcomeScreen，每次启动从欢迎页开始',
        '会话分组修复 — 修复同一文件夹出现两个分组的问题',
        '标题栏拖拽 — 原生 data-tauri-drag-region 替代 JS hack，支持双击最大化',
      ],
      en: [
        'Model ID update — claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 + auto localStorage migration',
        'New task flow — Sidebar button navigates to WelcomeScreen, app starts fresh each launch',
        'Session grouping fix — Fixed duplicate project groups in sidebar',
        'Titlebar drag — Native data-tauri-drag-region replaces JS hacks, double-click maximize works',
      ],
    },
  },
  {
    version: '0.2.0',
    date: '2026-02-16',
    highlights: {
      zh: [
        'CLI 自动检测与安装引导 — 首次启动自动检测 Claude CLI，未安装时分步向导引导，无需终端',
        '术语变更「对话」→「任务」 — 全部用户界面文案统一为面向目标的任务概念',
        '主题色彩全面改版 — 四套新配色，移除毛玻璃效果，Apple Squircle 圆角',
        '斜杠命令过滤修复 — 输入字母后优先匹配名称开头，不再显示所有命令',
      ],
      en: [
        'CLI auto-detect & setup wizard — First-launch detection with step-by-step guide, no terminal needed',
        'Terminology: Chat → Task — All UI text updated to goal-oriented "Task" concept',
        'Theme color overhaul — Four new palettes, removed glass effects, Apple squircle corners',
        'Slash command filter fix — Typing a letter now prioritizes name-prefix matches',
      ],
    },
  },
  {
    version: '0.1.1',
    date: '2025-12-01',
    highlights: {
      zh: [
        '修复 rewind 删除项目文件',
        '新增错误边界',
      ],
      en: [
        'Fixed rewind deleting project files',
        'Added error boundary',
      ],
    },
  },
  {
    version: '0.1.0',
    date: '2025-12-01',
    highlights: {
      zh: [
        'BLACKBOX 首发 — Claude Code 桌面 GUI 客户端',
        'NDJSON 流式聊天 + 文件浏览器 + 会话管理 + 快照回退',
        '中英双语界面 + macOS 透明标题栏原生集成',
      ],
      en: [
        'BLACKBOX initial release — Desktop GUI for Claude Code',
        'NDJSON streaming chat + file explorer + session management + snapshot/rewind',
        'Chinese/English bilingual UI + macOS transparent titlebar integration',
      ],
    },
  },
];

export function getChangelog(version: string): ChangelogEntry | null {
  return CHANGELOG.find((e) => e.version === version) || null;
}
