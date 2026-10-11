# 已知问题与审查归档

最后核验：2026-10-11

## 当前状态

当前没有已复现且尚未修复的阻断性或影响主要使用流程的问题。

这不表示项目在所有环境中绝对无缺陷。当前验证边界如下：

- 浏览器端到端测试以 Chromium 内核为主，未覆盖 Safari 与 Firefox 的完整交互矩阵。
- 已覆盖 360x640 到 3840x2160 的响应式布局，但没有执行持续整节课时长的 300 页内存压力测试。
- 多标签页自动保存冲突由 Web Locks 防护；不支持 Web Locks 的旧浏览器会退化为单标签使用假设，并在控制台记录兼容性信息。
- 公告内容目前由 `js/features/announcement/announcement-manager.js` 内的本地化资源管理，不存在独立的远程公告配置源。
- 删除页面不进撤销历史（与新建页面一致，分页操作均不可撤销）；删除前有一次确认弹窗。复制页面同样不进撤销历史（非破坏性操作，无需确认，删除副本即等效撤销）。
- 计时器（秒表/倒计时/课堂模式计时）在刷新后不恢复：计时器是授课过程中的临时悬浮件，与 GIF 悬浮层不同，未纳入会话持久化。
- GIF 悬浮层的 IndexedDB 状态没有跨标签页同步：A 标签删除 GIF 后，B 标签的下一次保存会按 last-write-wins 把它写回（旧 localStorage 路径同样没有同步，非回归）。

发现新问题时，应先添加最小复现测试，再在本文件的”当前状态”下记录适用环境、复现步骤和影响范围。

## 2026-10-11 审计归档（计时器单调时钟专项 + 复制页面）

例行维护轮：深读复核了 2026-09-27 引入的删除页面功能（页号键控状态搬运、上限守卫、UI 同步、确认弹窗与 8 语言键，未发现缺陷），并重跑了自动一致性检查（sw.js 预缓存 79+17 与磁盘/版本一致、index.html 333 个 i18n 引用全部有键、8 语言键齐平——德/西/法/日/韩约 100 键走 en-US fallback 属既有设计）。专项深读了此前仅定向扫描的 timer.js 全文与 classroom-mode 计时器，先写失败测试再修复 1 项缺陷，并新增复制页面功能。

### 提交一：计时器墙钟依赖（fix）

| 范围 | 问题 | 回归测试 |
| --- | --- | --- |
| timer.js + classroom-mode.js | 全部 elapsed 计时基于 `Date.now()` 墙钟差值（`updateTimer`、`startTimerLoop`、暂停恢复、课堂秒表的 `syncElapsedFromClock`/`pauseTimer`）。教室一体机课中 NTP 对时会让墙钟跳变：倒跳使秒表倒退、倒计时凭空加时；正跳使倒计时瞬间归零、课堂计时器虚增（`Math.max(0,…)` 只挡住了倒退方向）。全部改经 `performance.now()` 单调时钟（无 Performance API 环境回退 `Date.now()`），双方向跳变下计时只消耗真实流逝时间 | `timer-monotonic-clock.test.js` |

### 提交二：复制当前页（feat）

分页此前只能新建（空白）与删除，做“变式练习页/重做页”只能从空白页重建。分页条新增“复制当前页”按钮（复制图标，位于删除按钮左侧，达 300 页上限禁用，无需确认——非破坏性、删除副本即撤销）：`duplicatePage` 先固化当前页快照（位图/场景/背景/教具），在当前页之后插入副本并把所有页号键控结构上移一位（`shiftPageIndexedStateAfterInsertion`，pageBackgrounds 及其持久化、pageScenes、`shiftPageToolStatesAfterInsertion`、raster fallback 三件套、快照访问序），副本继承源页条目：背景条目深克隆（池指纹引用不受影响）、场景经 `capturePageScene` 活捕全新对象（保留贴图 imageElement 引用、无跨页别名）、位图快照共享引用（槽位整存整取、从不就地修改）、教具逐条克隆、raster fallback 基底共享引用；副本成为当前页并经 `loadPage` 装载。仅支持复制当前页（场景活捕读的是当前画布）。与新建/删除一致不进撤销历史。新增 `page.duplicatePage` i18n 键 8 语言同步。回归测试 `pagination-duplicate-page.test.js`。

同轮记录、未改动的事项：德/西/法/日/韩 locale 相对 zh-CN 各缺约 100 键（fallback 链兜底显示英文，属翻译完备度而非缺陷）；计时器不随会话持久化恢复（临时教具定位，已记入“当前状态”）。

本轮验证基线：core 66 项、full 113 项（含真实 Chromium 绘图冒烟与 8 视口响应式检查）、静态发布构建。版本 2.5.6 → 2.5.7（version.txt 同步至 package.json、package-lock.json、manifest.json 图标 URL、index.html manifest 链接、sw.js SW_VERSION 与 CORE_ASSETS 图标条目、README 徽章）。

## 2026-09-27 审计归档（跨页教具复核 + GIF 存储专项 + UI 静默失败）

对 2026-09-12 轮引入的跨页教具持久化与 GIF IndexedDB 迁移做了复核审计，先写失败测试再修复 11 项缺陷，并新增删除页面功能。修复分三个提交落地，全部逐项确认未修复实现下测试为红，另以真实 Chromium 验证删除页全流程、撤销按钮状态刷新与教具跨页不泄漏。

### 提交一：教具跨页持久化三缺陷（fix）

| 范围 | 问题 | 回归测试 |
| --- | --- | --- |
| 新建页路径 | `addPage`/`nextPage`/`nextOrAddPage` 三条新建页路径都没调 `restorePageState`（只有 `goToPage`→`loadPage` 有）：旧页教具泄漏到新页 overlay 上，且下次翻页时被 `saveCurrentPageState` 固化进**新页**快照——一把直尺经”+ 新建页”再翻页后同时存在于两页。三条路径补齐换页调用 | `teaching-tools-page-persistence-regression.test.js` |
| 会话快照 | `buildSyncSnapshot` 与 `saveSession` 只读 `exportPageToolStates()`（上次翻页的快照），从不捕获当前页 live 工具：拖动/新增/删除教具后不翻页直接刷新，改动回跳到上次翻页状态。两处保存前先 `saveCurrentPageState(currentPage)` | 同上 |
| 恢复合并 | `mergeRecoverySettings` 对 `pageTeachingTools` 取并集，与 `pageBackgrounds` 的”snapshot 整体胜出”文档化策略相反：项目导入重置后（snapshot 携带空 map）若 IndexedDB 写入失败，下次启动旧教具从旧记录复活；且合并结果不做页数截断，孤儿页键会随后续 `goToPage` 新建而重现。改为 snapshot 整体胜出 + `trimPageIndexedState` 截断 | 同上 |

### 提交二：GIF 管理器五缺陷（fix）

| 范围 | 问题 | 回归测试 |
| --- | --- | --- |
| 迁移数据丢失 | `migrateLegacyStateToIndexedDb` 先删 localStorage 键、后写 IndexedDB：put 失败（配额/事务 abort）时回退路径读回空键，全部 GIF 无提示永久丢失。改为写提交成功后再删键，失败保留源键供回退恢复与下次重试 | `gif-manager-storage-regression.test.js` |
| 配额通知失效 | `withGifStateStore` 只挂 request 成功/失败；IndexedDB 配额错误发生在事务 **commit 阶段**（put 的 onsuccess 已触发），Promise 照常 resolve、`saveFailureNotified` 被重置，”保存失败”提示对 IDB 路径几乎不可能触发。readwrite 结果改为只在 `transaction.oncomplete` 后算成功 | 同上 |
| 粘滞拖拽 | 拖拽/缩放未 `setPointerCapture`、move 无 `e.buttons` 兜底：窗口外释放的 pointerup 不送达，指针回窗后无需按键即可继续拖动；右键/中键也会启动拖拽。补 capture + release、buttons=0 终止手势、主键检查 | 同上 |
| 手势监听泄漏 | 拖拽中 GIF 被移除（如加载失败路径）时 doc 级监听闭包引用已脱离容器残留。`removeGif` 主动结束活动手势 | 同上 |
| NaN 入库 | `buildStateSnapshot` 对未设置的 inline 宽高 `parseInt` 得 NaN 存进 IndexedDB，恢复侧靠 `if (options.width)` 的 falsy 巧合才没出事。快照字段统一过滤为有限整数 | 同上 |

同轮记录、未改动的事项：`saveState` 早到快照竞态（初始化窗口内程序化 `addFloatingGif` 才可能触发，用户交互路径窗口早已关闭）；IDB 连接无 `onversionchange` 处理（DB 版本恒为 1，暂无升级路径）；跨标签页状态同步缺失（见”当前状态”）。

### 提交三：UI 静默失败三处（fix）

| 范围 | 问题 | 回归测试 |
| --- | --- | --- |
| 撤销/重做按钮 | 按钮状态只在 `updateUI`（工具切换/成功撤销/会话恢复）里刷新：新会话第一笔提交后按钮仍禁用、只能用快捷键；翻页重置历史后按钮假活。`onStateChanged`（每次落笔提交、翻页、undo/redo 都触发）接入独立的 `updateHistoryButtons`；并给 `#undo-btn/#redo-btn` 补禁用视觉样式（它们是 `.tool-btn`，旧 `.history-btn:disabled` 从未命中） | `ui-feedback-regression.test.js` |
| 计分板删队 | 只剩一队时删除按钮照常渲染、确认弹窗照常弹出、确认后 `removeTeam` 静默 return。改为仅多于一队时渲染删除按钮 | 同上 |
| 计时器归零继续 | 倒计时归零后”继续”按钮可点但静默无响应（设计要求先重置，避免重启即再次触发结束铃）。保留语义，点击时 toast 提示需先重置（新增 `timer.finishedResetHint`，8 语言同步） | 同上 |

### 提交四：删除页面（feat）

分页此前只能追加（上限 300 页），误加的空页永远删不掉。分页条新增”删除当前页”按钮（垃圾桶图标，单页禁用，hover 红色警示）：确认弹窗后 `deletePage` 删除页位图并把所有页号键控结构下移一位（`pageBackgrounds` 及其持久化、`pageScenes`、`pageTeachingTools`、raster fallback 三件套、快照访问序），当前页随之 clamp 并重载；删除不进撤销历史（与新建页一致），新增 `page.deletePage*` i18n 键 8 语言同步。回归测试 `pagination-delete-page.test.js`；真实 Chromium 验证了单页禁用、中间页删除后键重排、当前页删除后 clamp、确认弹窗全流程。

本轮验证基线：core 64 项、full 111 项（含真实 Chromium 绘图冒烟与 8 视口响应式检查）、静态发布构建。版本 2.5.5 → 2.5.6（version.txt 同步至 package.json、package-lock.json、manifest.json 图标 URL、index.html manifest 链接、sw.js SW_VERSION 与 CORE_ASSETS 图标条目、README 徽章）。

## 2026-09-12 审计归档（启动链/基础设施专项 + 跨页教具升级）

对前五轮未逐行覆盖的约 9 千行（js/app/ 启动链、js/infra/、js/features/、main.js、history.js、sw.js、server.js、build-static.js）做了逐行审计，并对全部模块做模式扫描兜底；未发现高危或中危缺陷。先写失败测试再修复 4 项低级别缺陷，同时把 2026-09-09 轮遗留决策的教学工具升级为跨页保留对象，并将 GIF 悬浮层持久化迁移 IndexedDB。全部逐个回退实现确认测试会红。

| 范围 | 问题/变更 | 回归测试 |
| --- | --- | --- |
| 确认弹窗 | `DialogManager.showConfirm` 复用同一 modal 且无并发守卫：两个确认框生命周期重叠时第二个覆盖第一个的按钮处理器，第一个 Promise 永不 resolve，await 方静默挂起（现实触发窗口：启动期语言建议确认撞上用户操作）。改为重叠时排队串行；无弹窗时保持同步装配，兼容既有同步读取 modal 的调用点 | `dialog-confirm-queue.test.js` |
| 启动健壮性 | `DrawingBoard` 构造函数的 `drawingEngine.setEdgeDrawingManager` 无可选链（同函数其余可选依赖均走了降级路径）：DrawingEngine 脚本加载失败时启动以裸 TypeError 崩溃、无法定位。改为显式硬依赖检查并抛出含模块名的可读错误 | `main-drawing-engine-dependency.test.js` |
| GIF 悬浮层 | 拖拽/缩放同时绑定 pointer+mouse+touch 三套事件，混合指针下每次移动触发两次且无 pointerId 归属；状态持久化走 localStorage，大于约 4 MB 的 GIF 必然超配额、只能弹一次提示后随刷新丢失。改为纯指针事件（touch-action:none 已就位），持久化迁移 IndexedDB（结构化克隆，无 JSON 字符串化），旧 localStorage 数据一次性迁移后删除，IndexedDB 不可用时回退原 localStorage 路径，“清除本地数据/清除画布数据”同步清理 IndexedDB 副本 | `gif-pointer-persistence.test.js` |
| SW 版本探测 | fetch handler 用 `pathname === '/api/version'` 绝对路径相等判断，子路径部署（GitHub Pages 项目页）永不命中；`/version.txt` 分支一直兜底。改为 `endsWith` 匹配，与 pwa-manager 的探测 URL 处理一致 | `teaching-tools-wiring.test.js` |
| 教学工具（功能升级） | 直尺/三角板从“刷新即失的临时教具”升级为跨页保留对象：每页快照存 `pageTeachingTools`（同 pageBackgrounds 模式，逐页 ≤40 件、最多 300 页，导入状态全部消毒），翻页经 `saveCurrentPageSnapshot`/`loadPage` 保存与恢复，会话记录与同步快照携带（恢复合并时快照侧优先），恢复会话后重放当前页工具，项目导入重置（项目包格式未扩展，旧包导入即清空），空板离开确认计入教具，缓存清理键补齐。仍不进撤销历史与导出位图：教具是授课辅助，不应被印进讲义或被撤销打翻 | `teaching-tools-page-state.test.js`、`teaching-tools-wiring.test.js` |

仍按既往记录保留的事项：`beforeunload` 同步快照在超大盘上的主线程停顿理论代价（已有 256 KB 截断）；坐标 overlay 的函数图像求值在几何变化时逐次重算（有界）。

本轮验证基线：core 60 项、full 107 项（含真实 Chromium 绘图冒烟与 8 视口响应式检查）、静态发布构建。版本 2.5.4 → 2.5.5（version.txt 同步至 package.json、package-lock.json、manifest.json 图标 URL、index.html manifest 链接、sw.js SW_VERSION 与 CORE_ASSETS 图标条目、README 徽章）。

## 2026-09-09 审计归档（未覆盖模块专项）

对 2026-09-05 轮未逐行覆盖的约 2 万行模块（export、project-manager、background、shape-drawing、teaching-tools、scoreboard、image-controls、insert-image、classroom-mode、settings-manager、i18n、pwa-manager、cache-runtime、panel/overlay、random-picker；timer.js 为定向扫描）做了一轮专项审计，先写失败测试再修复 4 项缺陷，全部逐个回退实现确认测试会红。本轮同场复核了 sw.js 预缓存清单（79 项 ESSENTIAL + 17 项 locale 全部在磁盘存在）、index.html 本地引用与 manifest 图标，无漂移。

| 范围 | 问题 | 回归测试 |
| --- | --- | --- |
| 项目导入 | `applyImportedProjectState` 把导入包里逐页携带的完整 `backgroundImageData` 直接写入 `pageBackgrounds` 与 localStorage，没有走 2026-09-05 引入的共享池去重。导出→导入一个 30 页共享 2 MB 背景的项目即重现旧缺陷：导入瞬间写入 ~60 MB 超配额静默失败（且主线程有一次大字符串序列化停顿），内存与 IndexedDB 会话携带 N 份拷贝，只有逐页访问才慢慢衰减。现在导入时通过 `AboardPaginationRuntime.sharePageBackgroundPayloads` 逐页池化并持久化（池 + 页条目一起写），旧格式内联载荷同样被收纳 | `known-issues-2026-09-09-regression.test.js` |
| 坐标叠加层 | `renderCoordinateOriginSvg` 把 `backgroundColor` 原样插值进 `stroke="..."` 属性，是整个 overlay 里唯一没过 `sanitizeSvgColor` 的颜色出口；导入包或损坏存储中的恶意颜色值可借此向 SVG 注入属性（其余渲染路径均已消毒，`background-coordinate-overlay-color-escaping.test.js` 只覆盖了 plots/points 路径）。改为同样消毒，无法解析时回退白色描边 | 同上 |
| 坐标叠加层 | `renderCoordinateOverlay` 每次调用都重建整个 SVG `innerHTML`；拖不透明度/强度滑条时每个 input 事件触发一次全量 DOM 重解析。仿照 `backgroundPatternMarkup` 增加 markup 字符串缓存（含 SVG 节点重建时的强制重写与禁用态缓存置空，避免旧内容残留） | 同上 |
| 图片导出 | 单页导出 `downloadCanvas` 用 `toDataURL` + `link.href` 下发 data: URL，Firefox 会拦截此类下载（多页 zip 路径早已走 `toBlob` + objectURL）。统一改为 Blob 对象 URL，并顺带给文件名做了与 zip 路径一致的非法字符清洗 | 同上 |

同轮记录、未改动的事项：教学工具（直尺/三角板）为纯 DOM overlay，不进撤销历史、会话持久化、翻页与导出位图——按“临时教具”定位保留现状，若需跨页保留属功能增强；坐标 overlay 的函数图像求值在几何变化时仍会逐次重算（有界，未观察到实际卡顿）。

本轮验证基线：core 55 项、full 102 项（含真实 Chromium 绘图冒烟与 8 视口 × 15 状态响应式检查）、静态发布构建、sw.js 预缓存与磁盘/index.html/manifest 一致性复核。版本 2.5.3 → 2.5.4（version.txt 同步至 package.json、package-lock.json、manifest.json 图标 URL、index.html manifest 链接、sw.js SW_VERSION 与 CORE_ASSETS 图标条目）。

## 2026-09-05 全量源码审计归档

对约 5.5 万行 JS 做了一轮全量审计（全部模块通读或模式扫描兜底），先写失败测试再修复 4 项缺陷与 2 项健壮性缺口，全部逐个回退实现确认测试会红。修复集中在会话持久化体积、选区几何与离开确认。

| 范围 | 问题 | 回归测试 |
| --- | --- | --- |
| 页面背景持久化 | `recordPageBackground` 把完整 `backgroundImageData` 逐页复制，`savePageBackground` 每次翻页对整个 map 做 `JSON.stringify` 写 localStorage。一张 2 MB 背景图配 30 页 = 每次翻页写 ~60 MB，超配额后静默失败，页面背景持久化从此失效；IndexedDB 会话同样被结构化克隆成 N 份。改为大于 2048 字符的载荷以指纹存入板级共享池（`sharedPageBackgroundImages`，localStorage 同名键 + IndexedDB 会话字段同步携带），页面条目只留 `shared:<指纹>` 紧凑引用；恢复/导出（项目包资产机制不变）与旧格式数据全部兼容，池在每次持久化时按引用裁剪 | `known-issues-2026-09-05-regression.test.js` |
| 选区几何 | `getStrokeSelectionBounds` 旋转分支的 padding 只算 `size * 2`，漏掉 `getStrokeStyleOuterExtent`（双线/三线/多线外沿），旋转后的多线笔迹选框比墨迹外沿紧一圈（与未旋转分支不一致） | 同上 |
| 文本缩放 | 文本对象用上下边缘手柄缩放时 `fontSize` 只按宽度比例计算：宽度不变 → 字号不变，只有 y 在移动，松手后选框跳回实际文本高度。改为按拖拽轴取比例（上下手柄用高度，其余用宽度），并给单文本路径补上复合选择路径已有的 `Math.max(startBounds[axis], 1)` 零宽保护，防止 0 宽起始 bounds 把 `fontSize` 污染成 Infinity | 同上 |
| 离开确认 | `beforeunload` 无条件弹“确认离开”：空板打开就刷新也弹。新增 `boardHelpersRuntime.isBoardContentEmpty`（单页、无笔迹/文本/图片/背景图/坐标内容、默认背景色与空白图案才算空），空板且会话写入未被锁时跳过确认；写锁冲突与任何实际内容仍然提示 | 同上 |
| 对齐参考线 | `parseColor` 不支持 8 位 hex 与 4 位简写（`#rrggbbaa` 背景会让对比度检查静默失效、不垫描边）。补齐两种格式（忽略 alpha 通道） | 同上 |
| 图案颜色亮度判断 | `isLightBackground` 按 `#rrggbb` 固定偏移切片解析背景色，非 6 位 hex 输入（`#fff`、8 位 hex、`rgb()/rgba()`、CSS 关键字、损坏的导入数据）亮度算出 NaN、一律误判为深色，浅色板上图案线条用白色绘制而不可见。改为覆盖上述全部格式解析通道值，无法解析的值默认按浅色处理（页面底色为白，默认深色墨线保持可见） | `known-issues-2026-09-05-regression.test.js` |

本轮验证基线：core 54 项、full 101 项（含真实 Chromium 绘图冒烟与 8 视口 × 15 状态响应式检查）、静态发布构建。修复期间曾出现一次 full 套件尾段失败，单独复跑两个冒烟测试与整条 full 套件均通过，判定为环境抖动而非回归。

本轮审计明确撤销一个误报：`StorageManager.estimateSessionSize` 的 metadata 分支已把完整 `settings`（含 `pageScenes`、`uploadedImages` 的 data URL）计入 `JSON.stringify` 体积，设置页的会话大小估算没有低估问题。

审计中记录、已在同轮补修的事项：`isLightBackground` 非 hex 背景色健壮性缺口见上表。仍留待后续决策：`beforeunload` 同步快照在超大盘上仍有主线程停顿的理论代价（已有 256 KB 截断，本轮未改动）。

## 2026-09-01 审计归档

对撤销历史、选区测量与字体路径做了一轮定向审计，修复 3 项缺陷，提交于 `51e5f7a`。三项都先写失败测试再改实现，并逐个回退实现确认测试会红。

| 范围 | 问题 | 回归测试 |
| --- | --- | --- |
| 撤销历史 | `trimToMemoryLimit` 从头无条件淘汰到只剩 1 条。当最新一帧自身超过 `memoryLimitBytes`（raster fallback 页面必须保留完整合成位图）时，上限无论怎么淘汰都追不上，于是整个撤销栈被清空且一个字节都没省下 | `known-issues-regression.test.js` |
| 撤销历史 | `getEntryByteLength` 只数位图字节，而 `createHistoryEntry` 会主动丢弃超过 `singleBitmapMemoryLimitBytes` 的位图、只留场景；场景携带 `stampedImages` 的 data URL 与笔迹点数组，却按 0 字节记账，上限形同虚设 | `known-issues-regression.test.js` |
| 文字选区 | `buildTextFontString` 把未加引号的自定义字体名拼进 CSS font shorthand。字体名直接取自上传文件名，`2024新字体` 这类不是合法 CSS 标识符，整条声明失效、`ctx.font` 赋值被静默忽略，于是用上一个字体测量，选框与实际渲染错位。渲染路径已走 `normalizeFontFamilyForCanvas`，测量改为复用同一函数。与 `b71c7b4` 同类，当时只修了 drawing.js 的 SVG 路径 | `known-issues-regression.test.js` |

同轮新增智能对齐参考线，提交于 `7f10c96`（`js/modules/alignment-guides.js` + `js/selection.js` 接线）。几何为纯函数、不碰 DOM；参考线画在 `#transform-layer` 内的独立 overlay canvas 上，因此不会进入历史快照与导出位图，`stopDrag` 在任何保存前清除，`clearSelection` 也清除以覆盖 pointercancel 与翻页。

已知边界：
- 旋转过的对象在吸附中被双向排除——其轴对齐外接框与视觉边缘不一致，画出来的参考线会指向空处。
- 背景图与坐标点不参与吸附，它们各自有自己的坐标系。
- 参考线的视觉观感当轮只验证了坐标与图层，未做像素级核对。后续补测时发现两项真实缺陷，见下一节。

本轮验证基线：core 53 项、full 100 项（含真实 Chromium 绘图冒烟与 8 视口 × 15 状态响应式检查）、静态发布构建、真实 Chromium 下的对齐吸附与 overlay 图层检查。

## 2026-09-01 参考线可见性与图层几何跟进

上一节把「参考线的视觉观感未核对」记为已知边界。补做这项核对时发现两项真实缺陷，都不是观感问题而是功能缺陷。修复与本节说明在同一提交里（`ba9955d` 之后的那个 fix 提交）。

| 范围 | 问题 | 回归测试 |
| --- | --- | --- |
| 参考线图层几何 | overlay 与画布同在 `#transform-layer` 里，但 overlay 用 `inset:0` + `width/height:100%` 贴的是**图层**，而画布是棋盘自身尺寸。1080p 窗口下图层 1920 CSS px、画布 1280 CSS px，overlay 的 1280 内部坐标被拉伸到 1920 的盒子里，**每条参考线都画在它所标注边缘的约 1.5 倍位置外**（实测偏移 235px）。吸附计算一直是对的，画出来的线一直是错的。改为每次渲染都对齐画布的布局盒（`offsetLeft/Top/Width/Height`），因为画布会随窗口、缩放与翻页改变 | `alignment-snap-wiring.test.js` |
| 参考线对比度 | `#f43f5e` 对 index.html 里四个深色板子达不到 WCAG 1.4.11 的 3:1 非文本对比度下限：墨绿 2.52:1、绿 1.32:1、深棕 2.40:1、棕 1.93:1。绿板上实测合成像素 2.17:1，基本看不见——而这正是一体机上最常用的板子。改为按背景决定是否在参考线下面垫一层描边：够 3:1 就保持原样的单像素线，不够就垫白或近黑（取对比度更高的一侧）。背景取的是 `background-canvas` 的**实际像素**（每手势采一次 3x3 网格），所以背景图也覆盖得到，而不是只看配置色 | `alignment-guides.test.js`、`alignment-snap-wiring.test.js` |

两项都先写失败测试再改实现，并逐个回退实现确认测试会红（共 4 处变异：casing 恒为 null、不解析 casing、core 与 casing 描边顺序颠倒、透明像素按黑色计；外加 overlay 盒子的 2 处）。

真实 Chromium 下的核对结果：8 个背景预设全部达到 3:1（原本通过的 4 个保持单像素线不变，失败的 4 个垫白后为 4.86:1 到 9.25:1）；虚线 `ink:5 gap:4` 在 core 与 casing 两列都完好，垫层没有把虚线间隙填平；overlay 盒子与画布盒子比值 1.0000，参考线与它标注的边缘同在屏幕 x=380.3，偏移 0px；缩放 1x/2x/4x 下该不变量依旧成立且吸附精确落位。另外单独验证了背景图路径：把 `background-canvas` 画成深绿而把配置色留成白色，采样读到深绿并正确垫白——只看配置色的实现会漏掉这种情况。

仍未做的：真实一体机上的主观观感（虚线疏密是否顺眼、垫白在强光教室里是否发闷）。数值与几何已核对，剩下的只能目视。

## 2026-07-27 桌面快照审计归档

以 `C:\Users\lenovo\Desktop\Aboard-main` 为审计快照，对 Git 工作区逐项复现并修复了快照问题清单中的有效缺陷。主要闭环如下：

| 范围 | 已处理内容 | 主要回归测试 |
| --- | --- | --- |
| 会话、导入与缓存 | 压缩包解压预算、图片尺寸预算、场景数字规范化、清理键白名单、恢复/清理期间的保存守卫 | `known-issues-2026-07-26-regression.test.js`、`session-*.test.js`、`project-import-background-reset.test.js` |
| 触控与选区 | 笔/触摸主指针语义、手势 pointerId 归属、旋转/缩放本地坐标、图像和文字控制框一致性 | `event-setup-touchcancel.test.js`、`known-issues-followup-regression.test.js`、`known-issues-regression.test.js` |
| 绘制与教学工具 | 多线笔迹持久化、笔型纹理重放、教具断笔、三角板旋转命中、形状预览钳制、缩放虚线间距 | `known-issues-drawing-regression.test.js`、`shape-*.test.js`、`drawing-live-preview-lazy.test.js` |
| 背景与导出 | 点阵/田字格 SVG pattern、英语四线格分组、显示设置合并、多页图片单 ZIP 下载 | `background-customization-resilience.test.js`、`export-page-readiness.test.js`、浏览器冒烟测试 |
| 文字与字体 | URL 富文本边界、Canvas 自定义字体族引用、待插入文字重复编辑 | `rich-text-parser.test.js`、`insert-text-modal-ux.test.js`、`known-issues-followup-regression.test.js` |
| 启动与 PWA | HelpSystem 延迟实例化、后置脚本重试/隔离/可见错误、完整离线预缓存、导航超时与 5xx 回退、启动版本超时 | `create-app-browser-check-order.test.js`、`script-loader-existing-script.test.mjs`、`sw-essential-assets.test.js` |
| 离线媒体 | 音频完整响应独立缓存，Range 请求按字节返回 206，离线重播不再依赖网络 | `sw-essential-assets.test.js`、`timer-audio-fallback.test.js` |
| 工程卫生 | 删除不可达的旧 StrokeControls 及全局监听，生产启动复用 ES5 浏览器预检，语言键与占位符零缺口 | `project-quality-guards.test.js`、`browser-check-no-eval.test.js`、`locale-files.test.js` |

本轮验证基线：core 44 项、full 91 项（含真实 Chromium 绘图冒烟与 8 个视口 x 15 个状态响应式检查）、静态发布构建、`npm audit --audit-level=high` 与 `git diff --check`。

## 2026-07 审查归档

2026-07-08 审查记录中的条目已经重新核对。以下问题已修复并由自动化测试覆盖：

| 原编号 | 已处理内容 | 主要回归测试 |
| --- | --- | --- |
| A1 | 多标签页会话写锁、失效传播与只读提示 | `session-write-lock-invalidation.test.js`、`session-planned-update-recovery.test.js` |
| A2 | 历史尺寸不匹配、大位图降级与页面位图内存预算 | `known-issues-regression.test.js`、`pagination-page-action-i18n.test.js` |
| A3 | 同步快照剔除超大 PNG、图片库和内联图片数据 | `known-issues-regression.test.js` |
| B1-B2 | 旋转中心与旋转后缩放的本地坐标换算 | `known-issues-regression.test.js` |
| B3 | 带样式形状保留旋转后的几何变换 | `shape-drawing-lazy-preview.test.js`、`shape-polygon.test.js` |
| B4 | 绘制中延后画质重建并取消过期定时器 | `known-issues-regression.test.js` |
| B5 | PWA 立即更新等待安装完成并显示失败反馈 | `known-issues-regression.test.js`、`pwa-*.test.js` |
| B6 | 粘贴后自动切换到选择工具 | `known-issues-regression.test.js` |
| C1-C3 | 文字选区无效手柄、轻点脏状态和手势阈值 | `known-issues-regression.test.js` |
| D1 | 补充 192/512 PNG 与 maskable PWA 图标 | `pwa-locale-guard.test.js`、`sw-essential-assets.test.js` |
| D4-D5 | 清理旧运行时副本并统一浏览器兼容检查入口 | `project-quality-guards.test.js`、`browser-check-no-eval.test.js` |

本次后续审查还补充了活动按钮的 `aria-pressed` 同步、混合触控设备点击目标、画布辅助名称、形状面板响应式覆盖和课堂激光笔。对应测试位于 `active-control-aria.test.js`、`classroom-mode-*.test.js` 与 `responsive-layout-smoke.mjs`。
