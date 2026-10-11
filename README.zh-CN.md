<div align="center">
  <img src="assets/banner.svg" alt="Academic Paper Copilot" width="860">
</div>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-4f46e5"></a>
  <img alt="Backend tests" src="https://img.shields.io/badge/backend%20tests-1276%20passing-2ea043">
  <img alt="Frontend tests" src="https://img.shields.io/badge/frontend%20tests-424%20passing-2ea043">
  <img alt="Python" src="https://img.shields.io/badge/python-3.12-3776ab">
  <img alt="React" src="https://img.shields.io/badge/react-18-61dafb">
  <img alt="Local-first" src="https://img.shields.io/badge/local--first-0f766e">
</p>

<p align="center">
  <b>读论文、读懂它、翻译它 —— 全在你自己机器上，用你自己的模型。</b>
</p>

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b>
</p>

---

Academic Paper Copilot 是一个本地优先的学术 PDF 阅读器。它让你始终面对**论文原文本身** —— 不是被重新录入的副本 —— 再围绕它把该有的东西建起来：抽取出的文档结构、能给出段落级引用的问答、你自己的笔记与高亮、整篇论文的翻译，一份把论文重排成单栏、逐段对照的阅读视图，以及一份写给**人**而不是写给机器看的阅读导览。

有三样东西可以离开这台机器，而且绝不会自己离开：你按下按钮发起的那几次模型调用；你交给 MinerU 解析器的论文 —— 前提是你配置了一个（本机部署的解析器会把论文留在你自己机器上）；以及你正在阅读的论文的 DOI 或标题，加上你输入的检索词 —— 前提是你开启了相关论文检索。没有账号、没有遥测、没有云同步、没有 CDN：浏览器只跟本机回环上的后端说话，后端只跟你配置的端点说话 —— 这就是全部的对外网络行为。

## 目录

- [它能做什么](#它能做什么)
- [截图](#截图)
- [快速开始](#快速开始)
- [配置模型服务](#配置模型服务)
- [工作原理](#工作原理)
- [阅读连续性](#阅读连续性)
- [证据，而非形容词](#证据而非形容词)
- [测试](#测试)
- [仓库结构](#仓库结构)
- [路线图](#路线图)
- [参与贡献](#参与贡献)
- [开源协议](#开源协议)
- [致谢](#致谢)

## 它能做什么

**概览 · 阅读入口。** 打开一篇论文，先看到的是**确定性**的导览 —— 完全由应用已经持有的抽取结果生成：标题、**逐字**的摘要、页数与一级章节数，以及"从哪一节开始读"的建议。这一步不调用任何模型。

**AI 论文概览。** 需要时点一下按钮：一次有界的模型调用，产出简短、逐条带证据的中文（或英文）条目 —— 研究问题、核心思路、主要贡献、方法、实验、发现、局限 —— **每一条都链接到它在论文里的页码**，模型归纳而非作者原话的条目会明确标出。生成结果按**论文内容的哈希**缓存：同一份 PDF 以后重新打开，或者删掉再导入，都是零成本、零调用。

**目录 · 笔记。** 跟随阅读位置的章节树；以及锚定在你选中文字上的笔记与高亮 —— 它们在重新抽取、重新导入、重启之后都还在，因为它们挂在**文档内容**上，而不是挂在某一行数据库记录上。

**Copilot。** 问论文不再挤掉目录：提问框有自己在右侧的独立栏，从顶栏开关。它从检索到的段落作答、给出引用，证据不足时直说"不足以回答"而不是猜测。

**翻译。** 通过本地翻译内核产出整篇译文、可导出的 2N 页原文/译文交替版。逐段对照的阅读以**后台任务**方式翻译：一批一批地填进来（默认 2 批并发、最多 4 批），每批落盘之后才请求下一批，**停止** 会保留已经付过费的部分，中断或失败的任务提供 **继续翻译剩余段落**，而不是从头再来。任何一个段落都可以单独 **重译此段** —— 一次调用，从该段落自己的悬停控件触发。每篇论文还自带一份 **术语表**：论文翻译时用到的术语、连同它们的译法列在一起，可以在一处集中修正。保存修正不花钱，并会说明它影响了多少段；只有那些段落会重新翻译。

**论文库。** 列出应用注册过的每一篇论文、每篇都有什么（译文、概览、笔记），以及最近一次成功翻译的记录 —— 语言对、引擎、时间。点开一行是**认领已有论文**而不是重新导入：所以切换不花钱，也不会多出一行记录。

**设置 · 模型服务。** 在界面里新建、编辑、删除、探测模型服务配置。配置项是 SQLite 里的一行，现在还带 **kind**（`llm` / `parser` / `search`）；**API Key 写进操作系统的凭据存储，永远不进数据库** —— 前端只会知道"有没有 key"以及一个掩码。key 是可选的，因为本地的 OpenAI 兼容服务本来就不需要。另有 **按任务选择模型** 界面，让翻译、问答、AI 概览、文献关系说明各用一个不同的 profile —— 未选择时跟随默认；选择以 profile id 持久化，绝不包含密钥内容。

> **语言说明。** 界面以简体中文为主（Chinese-first）；Reader Overview 可以生成中文或英文，界面其余部分尚未做多语言。

**逐段对照 · 重排阅读。** 论文重排成一栏可读的正文：按阅读尺度排版，每段正下方就是它的译文；而**像素本身就是内容**的东西 —— 图、表、行间公式、它们的题注 —— 以论文自己页面的裁切形式随流摆好，从矢量内容放大而不是拉伸。标题只来自抽取器派生的章节（绝不来自那个会把表格列头叫成 `title` 的版式分类），参考文献保留原文并说明原因，题注按排版惯例摆放（图题在下、表题在上）。译文每篇论文只生成一次，分批有界，按内容哈希缓存。

**公式重建 · 公式排版。** PDF 里的行间公式本质是一张图：抽取出来的文字是字形流（`LInfoNCE = −1 / 2B / B / X / i=1` 其实是一个求和号，上下限被拍平到了下一行），所以本应用从这个字形流和它周围的正文**反推** LaTeX，再用**本地打包的 KaTeX** 排版。因为反推有可能"看着很像但其实错了"，每一条都标注 **AI 重建**，点一下立刻换成论文原版裁切（带标注），再点一下换回来。模型**可以拒答** —— 认不出的公式保留论文原样，而不是给你一个看着合理的猜测 —— 解析不过的字符串**根本不会被渲染**。每 15 条公式一次调用，按论文内容哈希缓存，花钱之前先披露。行内 `$…$` 是保护而不是重建：段落离开本机前，每个公式都被替换成 `⟦mN⟧` 占位符，翻译结果里丢失、重复或凭空多出来的占位符会被拒绝，而不是显示出来。

**解析后端 · MinerU（可选，默认关闭）。** 内置抽取器（PyMuPDF 加本地版式模型）仍是默认，首次打开论文就会运行。把应用指向一个 [MinerU](https://github.com/opendatalab/MinerU) 服务 —— 本机、实验室机器或 mineru.net —— 论文就可以改由它重新解析：行间与行内的**真 LaTeX**、还原成表格的表、内置抽取器漏掉的标题。**MinerU 只通过 HTTP 调用，从不安装进本应用**；它的档位（`flash` · `basic` · `standard` · `advanced`）就是 profile 的 model 字段，而且它**永远不是默认**。它返回的结果保存在文档目录旁，所以之后重建 IR 不需要再解析一次。所有它还原的内容都带 **MinerU 识别** 标记，点一下就能换回论文自己的裁切图 —— 解析器会出错，而原文永远只差一次点击。指向 mineru.net 意味着把论文上传到它的服务器，设置界面会在你保存之前就说明这一点。

**相关论文 · 文献检索（可选开启）。** 文献 标签页列出论文的参考文献、引用它的论文、以及主题相似的论文，每一条都链回论文自己的文献表和引用它的那句话，可一键把开放获取的 PDF 导入论文库。它是唯一一个"打开面板就会访问网络"而不是"按按钮才访问"的功能，而且**在你添加一个检索 profile 之前是关闭的** —— OpenAlex、Semantic Scholar，或一个服务端自带联网检索的对话模型。发送的内容只有论文的 DOI（没有 DOI 时用 arXiv id，再没有就用标题）和你输入的检索词；正文与笔记不会发送。模型报告但链接不在检索返回结果中的论文会标为 **待核对**，而不是直接采信。

## 截图

下面八张是同一篇论文 —— **Deep Residual Learning for Image Recognition**（[arXiv:1512.03385](https://arxiv.org/abs/1512.03385)，公开论文）—— 在运行中的应用里的真实界面。它们由 [`frontend/scripts/capture-readme.mjs`](frontend/scripts/capture-readme.mjs) 采集：脚本从界面里注册一份自己的副本、拍完再删掉。翻译那张是在任务**还在跑**的时候拍的（101 段里的 9 段、9 批里的第 1 批）—— 一张"无法中断的任务"的截图只是说法，不是画面。

| 逐段 · 重排阅读 | Copilot · 划选一段，答在出处上 |
|---|---|
| ![逐段阅读](docs/screenshots/reader.png) | ![划选与 Copilot](docs/screenshots/copilot.png) |

| 逐段翻译 · 任务进行中 | 术语表 · 这篇论文只用一种译法 |
|---|---|
| ![翻译进行中](docs/screenshots/translation.png) | ![术语表](docs/screenshots/glossary.png) |

| 目录 · 跟着阅读走 | 笔记 · 锚在高亮上的笔记 |
|---|---|
| ![目录](docs/screenshots/outline.png) | ![笔记](docs/screenshots/notes.png) |

| 设置 · 每种工作一个模型 | 论文库 · 文库与搜索 |
|---|---|
| ![模型服务设置](docs/screenshots/settings.png) | ![论文库](docs/screenshots/library.png) |

## 快速开始

**环境要求。** Python **3.12**（抽取库支持的版本范围 —— 后端固定在这个版本）、Node **20+**，以及一篇 PDF。Windows / macOS / Linux 都可以，下面命令给出 Windows 写法，POSIX 的差异标注出来。

### 1. 后端

```bash
# Windows
uv pip install --python backend/.venv/Scripts/python.exe -e "backend[dev]"
cd backend && .venv/Scripts/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 \
    --no-server-header --no-date-header

# macOS / Linux
uv pip install --python backend/.venv/bin/python -e "backend[dev]"
cd backend && .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 \
    --no-server-header --no-date-header
```

```bash
curl -i http://127.0.0.1:8000/api/health
# {"status":"ok","version":"0.1.0"}
```

服务拒绝绑定到回环以外的地址，应用自己的配置模型也会拒绝非回环 host —— 配错了在启动时就失败，而不是悄悄把服务暴露出去。

### 2. 前端

```bash
cd frontend
npm install
npm run dev          # http://127.0.0.1:5173
```

打开地址，把 PDF 拖进阅读器，应用会抽取它的结构并显示阅读入口。**在你点按钮之前，不会有任何模型调用。**

在 Windows 上，仓库根目录的 `start.bat` 会依次启动后端、前端并打开浏览器：

```bat
start.bat
```

### 3. 你的数据在哪里

| 内容 | 位置 |
|---|---|
| 文档、抽取结果、译文 | `<数据目录>/documents/<document_id>/` |
| 概览缓存（按内容寻址） | `<数据目录>/documents/_cache/overview/` |
| 笔记、高亮、模型配置、任务 | `<数据目录>/db.sqlite3` |
| API Key | 操作系统凭据存储（`keyring`）—— 绝不在数据库里 |

`<数据目录>` 在 Windows 上是 `%LOCALAPPDATA%\AcademicPDFCopilot`，在 Linux/macOS 上是 `~/.local/share/AcademicPDFCopilot`。

## 配置模型服务

打开顶栏的**设置**，新建一条配置：名称、服务地址（endpoint）、模型名，以及可选的 API Key。**测试连接**只在点击时探测端点并报告结果；打开界面、选中配置、编辑字段都不会探测。

同一界面按 kind 分组：**parser** profile 指向 MinerU 服务（model 字段是解析档位），**search** profile 用来开启相关论文，**按任务选择模型** 决定每类工作用哪个对话 profile；三个设置界面都会在启用前说明会发送什么。

也可以从终端创建，适合没有浏览器会话的机器。Key 输入不回显，直接写进凭据存储：

```bash
python backend/scripts/configure_provider.py
# 或非交互式，从你自己 shell 里设的变量读取：
python backend/scripts/configure_provider.py --name Local \
    --base-url http://127.0.0.1:11434/v1 --model qwen2.5:7b --keyless
```

## 工作原理

```
              ┌──────────────────────────── 浏览器（React + Vite） ──────────────────────────┐
              │  阅读面板（PDF.js，窗口化渲染）   侧栏：概览 · 目录 · 文献 · 笔记              │
              │  Copilot 栏（问答）   设置 · 论文库 · 翻译对话框                               │
              └───────────────────────────────┬─────────────────────────────────────────────────┘
                                              │  HTTP，仅回环
              ┌───────────────────────────────┴─────────────────────────────────────────────────┐
              │  FastAPI 服务                                                                    │
              │                                                                                  │
              │   抽取 ──► DocumentIR ──► 章节 · 段落 · 锚点                                      │
              │       │  （内置 PyMuPDF + 版式模型，或可选的 MinerU 解析）                        │
              │       │                                                                          │
              │       ├─► 概览证据包 ─► 一次有界合成 ─► 按内容哈希缓存                            │
              │       ├─► 论文问答检索 ─► 带引用的回答                                            │
              │       ├─► 双语任务 ─► 分批 ─► 部分结果落盘 ─► 术语表 ─► 阅读                      │
              │       └─► 翻译内核 ─► 译文 · 2N 页交替版                                          │
              │                                                                                  │
              │   可选出网：MinerU 服务 · OpenAlex / Semantic Scholar / 联网检索模型              │
              │   SQLite：documents · tasks · annotations · profiles    OS keyring：API keys      │
              └──────────────────────────────────────────────────────────────────────────────────┘
```

五个想法撑起了绝大部分设计：

**抽取是整个系统的脊梁。** 目录、问答、笔记、概览、翻译上下文 —— 全都解析到同一个 `DocumentIR`：页面、章节、段落、文本块，以及让一段文字在重新抽取后仍然可辨认的锚点。

**身份是内容，不是行号。** PDF 的 SHA-256 才是概览缓存、笔记、检索索引与翻译产物的键。所以删掉再导入同一篇论文，你的笔记会回来；所以重开同一份字节永远不会二次付费。文档行是一次性的，内容不是。

**成本是设计约束，不是事后的顾虑。** 打开论文、读缓存里的概览、切换论文、刷新后恢复会话、列出论文库 —— 这些全部**测量过为零**模型调用，测量口径是一个包住应用能构造出的每一个 provider 的账本。只有按钮按下才花钱，而按钮会先告诉你。后台任务按批花钱：它把每一批先写进磁盘，再请求下一批 —— 所以停止一个任务不会浪费任何还没交付的东西。

**出网面是可选的，而且是明说的。** 只有两个功能能主动出网 —— MinerU 解析与相关论文检索 —— 两者在你建立 profile 之前都是关闭的，两个开启它们的界面都会说明将发送什么，而相关论文的接口在关闭时只会回答 `409 SEARCH_NOT_CONFIGURED`，什么都不做。

**界面不显示任何没有被测量的东西。** 概览会标出产出它的模型与服务商上报的 token 数 —— 或者直接说"Token 统计不可用"。论文库会显示最近一次成功翻译的语言对与引擎，**不显示模型名、token 数和耗时**，因为这三样系统从未记录。验收文档把这条规则一路带进了测试本身。

## 阅读连续性

以前刷新页面会关掉论文，现在不会了：阅读会话（哪篇论文、第几页、哪种模式、哪个面板）存在本地并在加载时恢复 —— 认领**已经存在的**文档行而不是重新导入，所以译文、笔记、缓存的概览都还在。关闭论文会**有意**忘记这次会话，所以"空工作区"是一个你可以主动选择并保持的状态。

翻译还能挺过的不只是刷新：它以服务端后台任务运行、每批都落盘，所以关掉窗口、刷新页面或重启后端之后，已完成的段落仍然是译好的，剩下的可以继续；会话记录现在还认得 文献 标签页，而且保存在已下线的并排 双语 模式里的会话会以 译文 打开，而不是坏掉。

## 证据，而非形容词

这个仓库里每一个任务都先写**验收标准**，再写实现代码：编号、可证伪、每条都写明它要求的证据。这些标准在 [`docs/acceptance/`](docs/acceptance/) —— 40 多份文档，每一份都以逐条状态收尾，并指明背后的具体测试、浏览器场景或测量数据；包括那些被修改过的标准（含原因），以及那些**失败**的标准。其中有两份尚未实现、并且自己说明了这一点：[`DS-DOC-011`](docs/acceptance/DS-DOC-011.md) 是表格排版的冻结契约，[`ADR-003`](docs/decisions/ADR-003-extraction-backend.md) 是允许存在第二种抽取后端的决策 —— 状态为 *proposed*，这正是 MinerU 可选、且永不作默认的原因。

有两个习惯值得单独说明，因为它们正是这些数字可信的原因：

- **测量被记录下来，而不是被回忆。** 模型调用数来自后端账本；包体积来自生产构建；缓存行为来自磁盘上的文件；划选行为来自真实 Chromium 里真实的鼠标拖拽。测不出来的，就写成"未测量"，而不是四舍五入成一个通过。
- **测试是用来抓产品的，不是用来抓代码的。** 浏览器 harness 驱动的是构建后的应用加真实后端，它们抓到过单元测试全都满意的缺陷 —— 其中包括一次"store 说在第 3 页、阅读器停在第 1 页"的恢复错误。

## 测试

```bash
# 后端 —— 1276 个测试，构造上完全离线
cd backend && .venv/Scripts/python -m pytest

# 前端 —— 424 个测试
cd frontend && npm run typecheck && npx vitest run && npm run build

# 浏览器验收 —— 真实 Chromium、真实后端、真实 PDF
cd frontend
node scripts/e2e-overview.mjs --generate     # 概览生命周期
node scripts/e2e-session-continuity.mjs      # 刷新后恢复论文
node scripts/e2e-document-library.mjs        # 论文库、切换、删除
node scripts/e2e-qa.mjs                      # 论文问答 —— 以及它驱动的划选拖拽
node scripts/e2e-notes.mjs                   # 笔记与高亮
node scripts/e2e-notes-search.mjs            # 笔记检索
node scripts/e2e-crosspage.mjs               # 跨页划选
node scripts/e2e-nonprose.mjs                # 图注与公式
node scripts/e2e-outline.mjs                 # 目录导航
node scripts/e2e-translation.mjs             # 翻译与阅读模式
node scripts/e2e-reflow-bilingual.mjs        # 逐段阅读与公式排版
node scripts/e2e-provider-settings.mjs       # 模型配置、探测、凭据存储
```

这十二个都通过 `node --check`，各自都有顶层驱动、以 0 或 1 退出。`scripts/e2e-selection.mjs` 是有意不列的：它是**模块**而不是 harness —— 它的划选拖拽检查由 [`e2e-qa.mjs`](frontend/scripts/e2e-qa.mjs) 驱动。[`docs/development.md`](docs/development.md) 逐个列出了每个 harness 读哪些参数与环境变量、哪些 probe 只测量不断言，以及测试套件的每一层各自看得见什么、看不见什么。

后端测试套件会让任何尝试打开非回环 socket 的测试直接失败，而且每个测试都用临时数据库 —— 测试跑一百遍也不会碰你的论文库。能够出网的功能也受同一条规则约束：MinerU、OpenAlex、Semantic Scholar 与模型联网检索都在进程内的传输层上被测试，所以测试套件在覆盖它们的同时依然不会打开任何非回环 socket。

浏览器 harness 会把你的数据目录复制到临时目录后再跑。它们同时会报告 provider 账本，这也是"这次没花钱"是**测量结果**而不是承诺的原因。公式 harness 跑在一个回环 stub provider 上，只要页面请求了任何非回环地址就会让整次运行失败 —— 离线优先在这里是一条被检查的属性，而不是一句声明。

## 仓库结构

```
backend/            FastAPI 服务
  app/document/     PDF 抽取 → DocumentIR，及其后端边界
  app/mineru/       可选的 MinerU 解析器：HTTP 客户端、转换器、暂存
  app/overview/     论文概览：证据包、提示词、流水线、内容寻址缓存
  app/bilingual/    逐段翻译：分批后台任务、术语表、公式守卫、缓存
  app/formulas/     从公式抽取出的字形流反推 LaTeX
  app/related/      相关论文：OpenAlex、Semantic Scholar、模型联网检索
  app/qa/           检索、查询扩展、作答
  app/annotations/  笔记与高亮，锚定在内容上
  app/pdfkernel/    翻译内核适配层
  app/llm/          provider 解析、调用账本、脱敏
  tests/            1276 个测试
frontend/           React + Vite 应用
  src/pdf/          阅读面板（PDF.js，窗口化渲染，文字层）
  src/qa/           划选捕获、范围、回答、引用
  src/overview/     阅读入口、生成的概览、会话
  src/bilingual/    重排后的逐段阅读（流式拼装、裁切、那一栏）
  src/formulas/     KaTeX 渲染、来源标记、与论文原图一键对照
  src/related/      文献 面板
  src/parsing/      阅读栏里的 MinerU 解析会话
  src/assistant/    左侧栏与 Copilot 栏
  src/library/      论文库
  src/settings/     模型服务、解析、检索与按任务选择的设置
  src/session/      跨刷新的阅读连续性
  scripts/e2e-*.mjs 浏览器验收 harness
docs/
  acceptance/       冻结的验收标准与逐条证据
  decisions/        架构决策记录（ADR）
  ARCHITECTURE.md   各部分如何拼在一起
  TEST_PLAN.md      哪一层验证什么
assets/             项目图形
```

## 路线图

- **表格排版** —— 表格与公式正好相反：它的结构是被*抽取*出来的，不需要模型，所以可以零调用排版。契约已冻结（[`DS-DOC-011`](docs/acceptance/DS-DOC-011.md)，10 P0 · 4 P1 · 2 P2）但尚未实现；实测 24/24 张表格可转换并通过 KaTeX 解析，20 张可配对的表格里 14 张在 0.70 阈值上排版，其余 6 张保留论文裁切，因为一张 19 列的表格排出来只有 5.7 px。
- **段内行内格式** —— 段落内部的加粗与斜体。抽取器目前会把文字片段拍平，所以像 **Abstract** 这样的小标题只能作为纯文本到达；实测这些论文里 22–57% 的行带样式，这正是"一堆文字"和"印出来的那一页"的差别。MinerU 解析已经能给出这些 run，所以这是第二个后端最先可能值回票价的地方。
- **引用跳转** —— 在重排栏里把 `[24]` 解析到它指向的那条参考文献。
- **落盘每次生成的用量** —— 记录 token 与耗时，让论文库的记录能说清一次翻译花了多少，而不是只能沉默。
- **界面多语言** —— 目前以中文为主，英文及其他语言待做。
- **英文界面的截图与文档。**

## 参与贡献

欢迎提 Issue 和 PR —— 详见 [CONTRIBUTING.md](CONTRIBUTING.md) 的两条项目规矩（**先写验收标准，再写代码**、**报告测量结果，而不是形容词**），以及 [`docs/development.md`](docs/development.md) 讲日常怎么做：测试套件的每一层看得见什么、确切的命令、什么才算证据、什么时候需要写一份 ADR。

## 开源协议

**GNU Affero 通用公共许可证 v3.0** —— 见 [LICENSE](LICENSE)。

这是 copyleft 协议，而且不是偏好问题：翻译内核 [PDFMathTranslate](https://github.com/Byaidu/PDFMathTranslate) 与 PDF 引擎 [PyMuPDF](https://github.com/pymupdf/PyMuPDF) 都是 AGPL-3.0，而本应用直接链接它们。因此 AGPL-3.0 是这个组合作品唯一可以分发的协议。如果你 fork 了这个项目，你分发出去的版本（或通过网络提供给别人使用的版本）也必须以 AGPL-3.0 开源。完整清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 致谢

- **[PDFMathTranslate](https://github.com/Byaidu/PDFMathTranslate)** —— 本项目驱动的翻译内核，也是协议必须是 AGPL-3.0 的原因。
- **[PyMuPDF](https://github.com/pymupdf/PyMuPDF)** —— PDF 解析、渲染与文本抽取（AGPL-3.0）。
- **[MinerU](https://github.com/opendatalab/MinerU)** —— 可选的结构化解析器，只通过 HTTP 调用、既不打包也不链接进本应用。它的协议不是 AGPL，这正是边界选择进程而不是 import 的原因；见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- **[OpenAlex](https://openalex.org/)** 与 **[Semantic Scholar](https://www.semanticscholar.org/product/api)** —— 可选的相关论文索引。
- **[PDF.js](https://mozilla.github.io/pdf.js/)** —— 浏览器内的阅读器。
- **[React](https://react.dev/)**、**[Vite](https://vite.dev/)**、**[Zustand](https://zustand.docs.pmnd.rs/)**、
  **[FastAPI](https://fastapi.tiangolo.com/)**、**[Tailwind CSS](https://tailwindcss.com/)**、
  **[lucide](https://lucide.dev/)** —— 其余技术栈。
