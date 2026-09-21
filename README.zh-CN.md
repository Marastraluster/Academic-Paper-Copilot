<div align="center">
  <img src="assets/banner.svg" alt="Academic Paper Copilot" width="860">
</div>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-4f46e5"></a>
  <img alt="Backend tests" src="https://img.shields.io/badge/backend%20tests-1129%20passing-2ea043">
  <img alt="Frontend tests" src="https://img.shields.io/badge/frontend%20tests-359%20passing-2ea043">
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

Academic Paper Copilot 是一个本地优先的学术 PDF 阅读器。它让你始终面对**论文原文本身** —— 不是被重新录入的副本 —— 再围绕它把该有的东西建起来：抽取出的文档结构、能给出段落级引用的问答、你自己的笔记与高亮、整篇论文的翻译，以及一份写给**人**而不是写给机器看的阅读导览。

除了你明确发起的那几次模型调用，什么都不离开这台机器。没有账号、没有遥测、没有云同步、没有 CDN：浏览器只跟本机回环上的后端说话，后端只跟你配置的那个端点说话 —— 这就是全部的对外网络行为。

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

**目录 · 论文问答 · 笔记。** 跟随阅读位置的章节树；从检索到的段落里作答、给出引用、证据不足时直说"不足以回答"而不是编造的问答；以及锚定在你选中文字上的笔记与高亮 —— 它们在重新抽取、重新导入、重启之后都还在，因为它们挂在**文档内容**上，而不是挂在某一行数据库记录上。

**翻译。** 通过本地翻译内核产出整篇译文、可导出的 2N 页原文/译文交替版，以及左右独立滚动的双语对照阅读模式。

**论文库。** 列出应用注册过的每一篇论文、每篇都有什么（译文、概览、笔记），以及最近一次成功翻译的记录 —— 语言对、引擎、时间。点开一行是**认领已有论文**而不是重新导入：所以切换不花钱，也不会多出一行记录。

**设置 · 模型服务。** 在界面里新建、编辑、删除、探测模型服务配置。配置项是 SQLite 里的一行；**API Key 写进操作系统的凭据存储，永远不进数据库** —— 前端只会知道"有没有 key"以及一个掩码。key 是可选的，因为本地的 OpenAI 兼容服务本来就不需要。

> **语言说明。** 界面以简体中文为主（Chinese-first）；Reader Overview 可以生成中文或英文，界面其余部分尚未做多语言。

## 截图

| 阅读器与即时入口 | 划选 → 提问，带范围 |
|---|---|
| ![阅读器](docs/screenshots/reader.png) | ![划选与问答](docs/screenshots/selection-qa.png) |

| 目录 | 笔记 |
|---|---|
| ![目录](docs/screenshots/outline.png) | ![笔记](docs/screenshots/notes.png) |

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
              │  阅读面板（PDF.js，窗口化渲染）   侧栏：概览 · 目录 · 问答 · 笔记                │
              │  设置 · 论文库 · 翻译对话框                                                      │
              └───────────────────────────────┬─────────────────────────────────────────────────┘
                                              │  HTTP，仅回环
              ┌───────────────────────────────┴─────────────────────────────────────────────────┐
              │  FastAPI 服务                                                                    │
              │                                                                                  │
              │   抽取 ──► DocumentIR ──► 章节 · 段落 · 锚点                                      │
              │                  │                                                               │
              │                  ├─► 概览证据包 ─► 一次有界合成 ─► 按内容哈希缓存                 │
              │                  ├─► 论文问答检索 ─► 带引用的回答                                │
              │                  └─► 翻译内核 ─► 译文 · 2N 页交替版                              │
              │                                                                                  │
              │   SQLite：documents · tasks · annotations · profiles    OS keyring：API keys      │
              └──────────────────────────────────────────────────────────────────────────────────┘
```

四个想法撑起了绝大部分设计：

**抽取是整个系统的脊梁。** 目录、问答、笔记、概览、翻译上下文 —— 全都解析到同一个 `DocumentIR`：页面、章节、段落、文本块，以及让一段文字在重新抽取后仍然可辨认的锚点。

**身份是内容，不是行号。** PDF 的 SHA-256 才是概览缓存、笔记、检索索引与翻译产物的键。所以删掉再导入同一篇论文，你的笔记会回来；所以重开同一份字节永远不会二次付费。文档行是一次性的，内容不是。

**成本是设计约束，不是事后的顾虑。** 打开论文、读缓存里的概览、切换论文、刷新后恢复会话、列出论文库 —— 这些全部**测量过为零**模型调用，测量口径是一个包住应用能构造出的每一个 provider 的账本。只有按钮按下才花钱，而按钮会先告诉你。

**界面不显示任何没有被测量的东西。** 概览会标出产出它的模型与服务商上报的 token 数 —— 或者直接说"Token 统计不可用"。论文库会显示最近一次成功翻译的语言对与引擎，**不显示模型名、token 数和耗时**，因为这三样系统从未记录。验收文档把这条规则一路带进了测试本身。

## 阅读连续性

以前刷新页面会关掉论文，现在不会了：阅读会话（哪篇论文、第几页、哪种模式、哪个面板）存在本地并在加载时恢复 —— 认领**已经存在的**文档行而不是重新导入，所以译文、笔记、缓存的概览都还在。关闭论文会**有意**忘记这次会话，所以"空工作区"是一个你可以主动选择并保持的状态。

## 证据，而非形容词

这个仓库里每一个任务都先写**验收标准**，再写实现代码：编号、可证伪、每条都写明它要求的证据。这些标准在 [`docs/acceptance/`](docs/acceptance/) —— 40 多份文档，每一份都以逐条状态收尾，并指明背后的具体测试、浏览器场景或测量数据；包括那些被修改过的标准（含原因），以及那些**失败**的标准。

有两个习惯值得单独说明，因为它们正是这些数字可信的原因：

- **测量被记录下来，而不是被回忆。** 模型调用数来自后端账本；包体积来自生产构建；缓存行为来自磁盘上的文件；划选行为来自真实 Chromium 里真实的鼠标拖拽。测不出来的，就写成"未测量"，而不是四舍五入成一个通过。
- **测试是用来抓产品的，不是用来抓代码的。** 浏览器 harness 驱动的是构建后的应用加真实后端，它们抓到过单元测试全都满意的缺陷 —— 其中包括一次"store 说在第 3 页、阅读器停在第 1 页"的恢复错误。

## 测试

```bash
# 后端 —— 1129 个测试，构造上完全离线
cd backend && .venv/Scripts/python -m pytest

# 前端 —— 359 个测试
cd frontend && npm run typecheck && npx vitest run && npm run build

# 浏览器验收 —— 真实 Chromium、真实后端、真实 PDF
cd frontend
node scripts/e2e-overview.mjs --generate     # 概览生命周期
node scripts/e2e-session-continuity.mjs      # 刷新后恢复论文
node scripts/e2e-document-library.mjs        # 论文库、切换、删除
node scripts/e2e-qa.mjs                      # 论文问答
node scripts/e2e-notes.mjs                   # 笔记与高亮
node scripts/e2e-crosspage.mjs               # 跨页划选
node scripts/e2e-nonprose.mjs                # 图注与公式
node scripts/e2e-outline.mjs                 # 目录导航
node scripts/e2e-translation.mjs             # 翻译与阅读模式
```

后端测试套件会让任何尝试打开非回环 socket 的测试直接失败，而且每个测试都用临时数据库 —— 测试跑一百遍也不会碰你的论文库。

浏览器 harness 会把你的数据目录复制到临时目录后再跑。它们同时会报告 provider 账本，这也是"这次没花钱"是**测量结果**而不是承诺的原因。

## 仓库结构

```
backend/            FastAPI 服务
  app/document/     PDF 抽取 → DocumentIR
  app/overview/     论文概览：证据包、提示词、流水线、内容寻址缓存
  app/qa/           检索、查询扩展、作答
  app/annotations/  笔记与高亮，锚定在内容上
  app/pdfkernel/    翻译内核适配层
  app/llm/          provider 解析、调用账本、脱敏
  tests/            1129 个测试
frontend/           React + Vite 应用
  src/pdf/          阅读面板（PDF.js，窗口化渲染，文字层）
  src/qa/           划选捕获、范围、回答、引用
  src/overview/     阅读入口、生成的概览、会话
  src/library/      论文库
  src/settings/     模型服务设置
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

- **段落级双语对照阅读** —— 原文与译文按段落交错，像沉浸式阅读插件那样的呈现，作为**新增**的阅读模式，不动现有的几种。
- **落盘每次生成的用量** —— 记录 token 与耗时，让论文库的记录能说清一次翻译花了多少，而不是只能沉默。
- **界面多语言** —— 目前以中文为主，英文及其他语言待做。
- **英文界面的截图与文档。**

## 参与贡献

欢迎提 Issue 和 PR —— 详见 [CONTRIBUTING.md](CONTRIBUTING.md)。有两条项目规矩比其他都重要：**先写验收标准，再写代码**；**报告测量结果，而不是形容词**。

## 开源协议

**GNU Affero 通用公共许可证 v3.0** —— 见 [LICENSE](LICENSE)。

这是 copyleft 协议，而且不是偏好问题：翻译内核 [PDFMathTranslate](https://github.com/Byaidu/PDFMathTranslate) 与 PDF 引擎 [PyMuPDF](https://github.com/pymupdf/PyMuPDF) 都是 AGPL-3.0，而本应用直接链接它们。因此 AGPL-3.0 是这个组合作品唯一可以分发的协议。如果你 fork 了这个项目，你分发出去的版本（或通过网络提供给别人使用的版本）也必须以 AGPL-3.0 开源。完整清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 致谢

- **[PDFMathTranslate](https://github.com/Byaidu/PDFMathTranslate)** —— 本项目驱动的翻译内核，也是协议必须是 AGPL-3.0 的原因。
- **[PyMuPDF](https://github.com/pymupdf/PyMuPDF)** —— PDF 解析、渲染与文本抽取（AGPL-3.0）。
- **[PDF.js](https://mozilla.github.io/pdf.js/)** —— 浏览器内的阅读器。
- **[React](https://react.dev/)**、**[Vite](https://vite.dev/)**、**[Zustand](https://zustand.docs.pmnd.rs/)**、
  **[FastAPI](https://fastapi.tiangolo.com/)**、**[Tailwind CSS](https://tailwindcss.com/)**、
  **[lucide](https://lucide.dev/)** —— 其余技术栈。
