# Physics Visualizer

> 输入中文物理题 → AI 自动生成可交互的 2D 物理仿真。**不是代码生成，是语义理解。**

**DSL 结构校验通过率：100%（DeepSeek Flash, 100 题基础运动学/动力学测试）** · 20 个手写示例 · 7 类力分量 · 全 SI 单位
> ⚠️ 测试覆盖以简单题为主（自由落体、抛体、单弹簧、两体碰撞）。复杂多体耦合场景仍需人工调参。结构通过 ≠ 物理正确——AI 生成的初始位置、质量、刚度等参数可能偏离物理实际。

## 启动

```bash
# 方式 1：一键启动（双击 start.bat）
# 方式 2：命令行
npm install
npm run dev          # → http://127.0.0.1:5173
npm test             # 16 tests
npm run typecheck
```

## 目录

```
src/
├── graph/          # DSL 类型 + 校验 + 归一化
├── sim/box2d/      # Box2D 世界/刚体/关节/力/事件
├── sim/            # 仿真循环 + 运动曲线
├── render/         # Canvas 渲染
├── services/       # AI 客户端 + DSL 生成 + 提示词
├── components/     # React UI
├── examples/       # 示例索引
schema/             # JSON Schema (1257 行)
scripts/            # 批量测试工具
examples/           # DSL JSON 文件 (20 手写 + 104 AI 生成)
```

## 技术栈

React 19 · TypeScript · Box2D-WASM · Canvas 2D · Vite 7 · Vitest · DeepSeek API

## 覆盖场景

自由落体 · 抛体 · 弹簧振子 · 弹性/非弹性碰撞 · 单摆/圆锥摆/双摆 · 铰链/滑轨/滑轮 · 斜面 · 匀强电场 · 点电荷(固定/移动) · 洛伦兹力 · 电磁复合场 · 时变/空间变化场 · 事件触发 · 表达式驱动 · 阻尼 · 摩擦

---

## 核心洞见

大多数"AI + 物理模拟"的思路是让 AI 写代码（Python/JS），然后执行。这条路脆弱——代码有语法错误、运行时异常、物理错误，三重风险叠加。

**我们的思路：让 AI 输出一种它和引擎都能理解的协议。**

这个协议就是 **Graph DSL**。它是一套 JSON Schema，描述物理场景的语义——有什么物体、怎么连接、受什么力、初始状态、何时触发事件。AI 负责"理解题目→填充协议"，Box2D 引擎负责"执行协议→生成运动"。两者通过协议解耦，各做各擅长的事。

```
题目文本 → AI 理解 → Graph DSL → Box2D 执行 → Canvas 渲染
              ↑                    ↑
         语义推理              数值积分
         (LLM 擅长)           (物理引擎擅长)
```

## 这里做什么，不做什么

**做什么**：高中物理题的场景理解与可视化。给定一段中文题目，自动识别场景中的物体、约束、力场、事件，生成可运行的仿真。

**不做什么**：不解最终答案（不求位移、速度数值），不画受力分析图，不批改作业。引擎计算运动，人观察运动。

## 技术层次

### Layer 1：Graph DSL — 为什么是协议而非代码

如果让 AI 直接生成 Box2D 调用代码：
- 每道题的代码结构不同，无法校验
- 坐标单位混乱（px vs m vs cm）
- 约束参数缺失时 AI 只能瞎猜

协议方案：
- **强结构**：JSON Schema 定义所有字段的类型、范围、必填关系（1257 行 schema）
- **可校验**：三层校验器（schema → constraint → execution），AI 输出不合格就自动修复
- **引擎无关**：今天用 Box2D，明天换 Matter.js，DSL 不变。协议描述物理，不描述实现

```json
// AI 输出这个，不是一堆 Box2D API 调用
{
  "version": "3.0",
  "objects": [{ "id": "ball", "type": "particle", "properties": { "mass": 1 } }],
  "interactions": [{ "model": "spring", "between": ["anchor", "ball"], "parameters": { "rest_length": 0.5, "stiffness": 100 } }],
  "fields": [{ "model": "uniform", "vector": [0, -9.81] }],
  "initial_state": { "ball": { "position": [0, 2.4], "velocity": [0, 0] } }
}
```

### Layer 2：AI 流水线 — 为什么是 IR 中介不是端到端

端到端（题目→DSL）的问题：模型同时做"理解"和"编码"，错误率高。复杂题（多实体+弹簧+碰撞+可变参数）连续超时。

**IR（中间表示）**是分治策略：
1. **分析阶段**：只做语义理解，输出结构化重述 + IR JSON。System prompt 只有 IR 契约，不塞 DSL schema（避免干扰）
2. **DSL 阶段**：拿到 IR（已含所有数值），换 System prompt 为 DSL schema + 完整示例，纯翻译
3. **修复阶段**：校验失败时自动回修，对话历史完整累积（模型看到自己的 IR + 错的 DSL + 错误列表）

三个阶段共享对话历史。阶段切换时替换 system prompt（`filter(m => m.role !== "system")`），保留所有 user/assistant 消息。模型在修 DSL 时能看到自己写的 IR——知道"我当时是想表达什么"。

**提示词设计的关键边界**：解决初态即可，不推演全过程。模型只需要算 t=0 的位置速度 + 题目要求的触发时刻。运动过程交给引擎。这个边界是分治的前提——没有它，模型会尝试算整个轨迹，然后超时。

### Layer 3：力场系统 — 为什么要看见力

物理可视化不是动画。动画只展示"物体怎么动"，物理可视化要展示"为什么这么动"。

**7 类力分量**，每类有独立的来源标签和颜色：

| | 来源 | 计算 |
|--|------|------|
| 重力/电场/磁场 | field 管道 | F=m·g / q·E / qv×B |
| 弹簧/关节/绳 | Box2D GetReactionForce | 约束反力精确值 |
| 支持力 | 接触冲量反算 | impulse/dt |
| 摩擦力 | 接触切向冲量 | tangent_impulse/dt |
| 阻力/阻尼 | 速度比例 | F=−c·v |
| 事件控制力 | Δv 反算 | m·Δv/Δt |
| 运动曲线等效力 | 位移/速度差反算 | m·Δv_eff/Δt |

Inspector 不仅显示数值，还画 SVG 时序图——任何物理量随时间的变化曲线。

**移动点源场**（`origin_from`）：径向场原点绑定到运动对象。两个自由电荷互相排斥时，每个电荷的电场上原点跟随自身移动，1/r² 力同时更新。渲染层同步显示场箭头的大小变化。

**Pairwise 参数**：摩擦系数和恢复系数是接触对属性，不是物体属性。A↔B 的弹性和 A↔地面独立控制。Box2D 每 substep 遍历接触链表，匹配 DSL constraint 覆盖 fixture 默认值。

### Layer 4：仿真细节

**绳约束迟滞带**：绳只拉不推。每 substep 判断：松驰（距离 < 0.97×绳长）→ 删除 joint；拉紧（距离 ≥ 绳长）→ 创建 joint。3% 区间保持上一状态，避免高频切换震荡。

**y-up 坐标系**：Canvas 默认 y-down，通过 `scale(zoom, -zoom)` 翻转为 y-up。世界坐标与数学坐标系一致：重力 [0, -9.81] 向下，正高度向上。平移/缩放/点击全部适配。

**Web Worker 隔离**：Box2D-WASM 在 Worker 中运行，主线程不阻塞。WASM 二进制预取绕过 Emscripten 的 fetch 链。

### 为什么这个方向值得继续做

当前最好的模型也无法完美理解物理——它们对力、运动、约束的推理仍然不稳定。但正因如此，**让 AI 生成代码的方案上限更低**：一句语法错误整个页面白屏，运行时异常直接崩溃，物理错误更难调试。协议方案把 AI 的不确定性关在 DSL 这层——错了可以校验、可以修复、可以人工改 JSON，不会整段垮掉。

当前物理表达的局限（无流体、无 3D、无刚体转动）本质上是 Box2D 引擎的能力边界，不是架构问题。DSL 协议可以向上扩展：换更全能的引擎或添加新类型，不影响已有场景和 AI 流水线。两天内做不到，但方向是可延续的。

## 架构一览

```
用户输入 (中文)
  │
  ├─→ AI 流水线 (DeepSeek Flash)    ──→ Graph DSL JSON
  │   · IR 分析 + 结构化重述
  │   · DSL 生成 + 自动修复
  │
  ├─→ 校验器 (schema / constraint / execution)  ──→ 拒绝或放行
  │
  ├─→ Box2D-WASM (Web Worker)      ──→ StateFrame[]
  │   · 子步积分 + 约束求解
  │   · 接触力 / 推断力计算
  │
  └─→ Canvas 2D + React            ──→ 可视化 + Inspector
      · y-up 物理坐标系
      · 矢量场实时渲染
      · 30+ 物理量时序图
```