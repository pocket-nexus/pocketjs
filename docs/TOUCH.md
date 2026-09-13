# PocketJS Touch — 从零到手感

在 PocketJS 里,触摸不是事件系统,是输入模态之一。你不写"点击处理器",
你声明"这个东西可以被激活/被滚动/被拖拽"——手指、d-pad、光标殊途同归。
写对了,你的应用在 Vita 触屏、PSP 十字键、桌面光标上跑同一份代码,零分支。

整个体系是一座三层金字塔,**从上往下用,能停就停**:

```
第 3 层   组件:Focusable / TextField / VirtualList          ← 90% 的应用停在这层
第 2 层   手势代数:createGesture / createScroller           ← 自定义组件的作者才下来
第 1 层   原始触点:touches() / auxiliaryTouches()           ← 你几乎永远不需要
```

每往下一层,你对确定性和多模态降级承担更多责任;停在上层,这两件事是平台的。

## 0. 一个按钮(你可能根本不需要 Touch API)

```tsx
import { Focusable, Text } from "@pocketjs/framework/components";

<Focusable onPress={() => play(video)}
           class="rounded-lg bg-[#1a2432] active:bg-[#243040]">
  <Text>PLAY</Text>
</Focusable>
```

tap、CIRCLE、光标点击走同一个 `onPress`;`active:` 变体在三种模态下行为
一致——手指按下高亮、松开触发、滑走取消(列表开始滚动时高亮自动熄灭,
见 §3 的认领)。注意你没有 import 任何 touch 相关的东西:激活是焦点体系
的语义,触摸只是到达它的一条路。

## 1. 文本输入:TextField

```tsx
import { TextField } from "@pocketjs/framework/osk";

<TextField value={query()} onInput={setQuery} onSubmit={search}
           placeholder="TYPE A QUERY" />
```

`TextField` = focusable + **editable**。任何模态的激活——点它、CIRCLE、
光标点击——自动召唤系统 OSK 并绑定这个字段;面板经 overlay 停靠,打开
期间身后的按键与手势被模态屏蔽,提交触发 `onSubmit` 并关闭。你不需要
管理 `isOpen`/`display` 镜像,不需要绑按键(想要 △ 快捷键:`ref` 暴露
控制器,`ref.open()` 一行)。字段与键盘是同一个垂直切片,所以都住在
osk 模块。

## 2. 长列表:VirtualList

```tsx
import { VirtualList, type VirtualListHandle } from "@pocketjs/framework/virtual-list";

let list: VirtualListHandle;

<VirtualList
  count={results().length}
  rowHeight={68}
  height={340}
  renderRow={(i) => <ResultRow item={results()[i]} />}
  onRowPress={(i) => play(results()[i])}
  onNearEnd={() => loadMore()}
  ref={(h) => (list = h)}
/>
```

免费得到:触摸 pan 跟手 + iOS 手感 fling(衰减/rubber-band/带初速回弹
都是平台常量)、行按压高亮与滚动取消、d-pad 焦点行走 + chase、光标
hover=focus、O(visible) 窗口化。Handle 补命令式入口:
`scrollToIndex(i, "center")`、`focusRow(0)`、`rebaseRows(n)`(顶部
prepend 不跳屏);聊天流加 `stickToBottom`。

行归属来自命中事实(§5):手指落在哪一行由**节点身份**决定,不需要告诉
组件任何屏幕几何;行间隙的 tap 是分隔条 tap——不触发(UIKit 惯例)。

## 3. 自定义手势:createGesture

什么时候下到这层:你要做的交互既不是激活也不是列表——播放器的划动、
进度条的 scrub、图片的拖拽。

```tsx
import { createGesture } from "@pocketjs/framework/gesture";

// 播放器:tap 切 HUD,下滑快甩退出
createGesture({
  onTap: () => toggleHud(),
  onPanEnd: (c) => { if (c.dy > 80 && c.vy > 240) exitPlayer(); },
});

// 进度条:x 轴锁定,拖动预览,松手才 seek
createGesture({
  region: { node: () => scrubNode },
  axis: "x",
  onPanMove: (c) => setPreview(fracFor(c.x)),
  onPanEnd:  (c) => seekTo(fracFor(c.x)),
});
```

`c` 是 `GestureContact`:

| 字段 | 含义 |
|---|---|
| `surface` | `primary` 或 `auxiliary`;决定坐标与命中树 |
| `x, y` / `startX, startY` | 当前/落点位置(逻辑 px) |
| `dx, dy` / `fdx, fdy` | 相对落点/本帧的位移 |
| `vx, vy` | 速度,逻辑 px/虚拟秒 |
| `hit` | 落点的命中事实(节点 id;§5) |
| `id, frames, downFrame` | 触点标识 / 按住帧数 / 落下帧 |

**唯一需要内化的概念:认领(claim)。** 多个识别器可以同时观察同一根
手指;第一个越过 `panSlop` 的识别器认领它,其余全部收到 `onCancel`——
"列表开始滚动,行的按压高亮熄灭"就是这个机制,你不写一行协调代码。
优先级 = 注册顺序,后注册者优先(内层组件后挂载,天然赢外层)。
`region.node` 圈定命中子树;不给 region 就是全屏识别器。速度和长按走
虚拟时钟——30Hz 模拟测试与 60Hz 真机数值逐位一致。

**辅助显示上的识别器必须声明 `surface: "auxiliary"`。** 默认值是
`"primary"`,因此现有单屏应用不会接收另一块显示的触点。

双指是同一个模型的延伸:`onPinchStart/Move/End` 观察同一识别器名下
最早落下的两根未被认领的手指。**跨距(span)按识别器的 `axis` 投影——
`"y"` 是 |ay−by|,整数;`"any"` 是欧氏距离,一次 IEEE 精确的
`Math.sqrt`。** 跨距变化越过 `pinchSlop` 且大于质心位移时,pinch 一次
认领两根手指(两指同向平移是滚动,不是捏合——质心项就是这个判据),
每帧交付 `GesturePinch`:两指位置、质心、`span/startSpan/dspan/fdspan`。
pinch 检查在单指 pan 认领之前跑,所以两指张开赢过它自己的滚动;任一
手指抬起或被取消,`onPinchEnd` 带着最终几何收尾。

手势层和动力学层是框架中立的(核心在 `gesture-core.ts` /
`kinetics-core.ts`):Solid 与 Vue Vapor 各有一层薄壳,差别只是
`createGesture` 挂接哪个作用域的清理钩子、offset 绑定 signal 还是
shallowRef。Vue Vapor 入口跑同一个手势泵,收同样的命中事实。

## 4. 自定义动力学表面:createScroller

VirtualList 不合身时(画布平移、carousel、缩放视口),物理引擎单独可用:

```tsx
import { createScroller, bindDpadScroll } from "@pocketjs/framework/kinetics";
import { createGesture } from "@pocketjs/framework/gesture";

const s = createScroller({ max: () => contentH() - viewH() });

createGesture({
  region: { node: () => viewportNode },
  axis: "y",
  onDown:     () => s.stop(),          // 手指落下,截停飞行中的 fling
  onPanStart: () => s.beginDrag(),
  onPanMove:  (c) => s.drag(c.dy),
  onPanEnd:   (c) => s.endDrag(-c.vy), // 松手速度直接变 fling 初速
});
bindDpadScroll(s, { active: () => focused() });   // PSP 降级,一行

// 渲染侧:每帧一次 paint-only 属性,零重排
<View style={{ translateY: -s.offset() }}>…</View>
```

`snap` 做分页/对齐(接收投影静止点,返回吸附目标),`onSettle` 报静止。
物理常量(fling 衰减、rubber 曲线、spring K/C)是平台字面量——所有
应用同一手感,所有宿主同一数值。物理积分刻意留在 guest 侧:窗口化每帧
要同步读 offset,而热路径读取永不跨界(定律一)。

## 5. 命中事实(为什么没有 touchRect 这种东西)

"手指落在哪"是 core 的知识(它拥有 layout 与绘制),所以它是宿主投递的
**事实**,不是 guest 发起的查询:宿主在触点**落下**的那一帧,对用户正在
看的已提交画面做一次**按布局盒**的命中(spec op 42 的语义:纯布局容器
认领自己的盒;行间隙也归列表),然后**随触点生命周期携带**(隐式捕获),
经 `frame()` 第 4 参与触点并行送达;第 5 参标记每个触点的 surface。
`GestureContact.hit` 和 `GestureContact.surface` 就是这两个事实。

- 拖动期间零 FFI:命中永不重解析
- 空的 overlay/portal 层标记 `hitPass`(自身对命中透明,内容照常认领)
  ——engine 版 pointer-events:none,系统 OSK 的停靠依赖它
- 无事实通道时(devtools 回放、注入宿主、旧 wasm)手势层按
  op 42 → op 27 → region.rect 逐级回退,确定性不变

## 6. 降级不是你的工作(但有一个开关)

| | Vita(触摸) | PSP(d-pad) | 桌面(光标) |
|---|---|---|---|
| `Focusable.onPress` | tap | CIRCLE | click |
| `TextField` | tap → OSK | CIRCLE → OSK | click → OSK |
| `VirtualList` | fling/tap | 焦点行走/chase | hover/click |
| `createScroller` | 手势驱动 | `bindDpadScroll` | 光标拖拽 |

唯一值得写分支的场景:交互**习语**本身不同。判据是能力,不是机型:

```tsx
import { hasFeature } from "@pocketjs/framework/platform";

// 触屏习语是无限滚动;按键习语是明确的 LOAD MORE 行
onNearEnd={hasFeature("input.touch") ? loadMore : undefined}
```

## 7. 模态表面

OSK 自动屏蔽身后的按键与手势。自建 modal 同款一行:

```tsx
import { pushTouchBlock } from "@pocketjs/framework/gesture";
onCleanup(pushTouchBlock());   // 挂上即屏蔽,清理即恢复;在途触点当帧 onCancel
```

## 8. 测试你的手感

手势输出是 `(tick, inputs)` 的纯函数,手感像逻辑一样可断言:

- **sim journey**:`touchGlide(x0,y0,x1,y1,t0,t1)` 脚本化一记 fling,
  断言帧哈希逐字节复跑(tests/im-sim.test.ts Journey E 是范本)
- **录/放**:`bun tools/tape.ts record --touch` 对单屏仍生成 tape v2;
  出现 auxiliary 触点时生成 tape v3 的稀疏 surface 轨道。命中事实
  **不录**——回放经匹配 surface 的查询回退确定性重解析
- **golden**:`GoldenSpec.touch(frame)` 让 e2e 在真渲染核上钉住
  "按住第 N 帧的按压高亮"这类按键 tape 表达不了的状态

## 9. 成本模型(实测)

计数宿主 + 真帧泵,200×68px 行的 VirtualList,快拖 8 帧 + fling 到静止:

| 阶段 | ops/帧 | 说明 |
|---|---|---|
| 静止(前后各 30 帧) | **0** | 泵是两次比较,零分配 |
| 手指落下 | 1 (+1 次核内命中) | `setActive` 行高亮;命中每触点一生一次 |
| 拖拽 | 均值 7.6,峰值 15 | 纯跟手帧 = **1**(translateY);换窗帧 = 15 |
| fling(185 帧) | 均值 2.1,峰值 15 | 稳态帧 = 1 个 setProp;真宿主还会把 prop 三元组批成单次穿越 |

参照:PSP 实测 FFI 预算 ~8000 ops/帧——峰值占 **0.2%**。手势与动力学
本身零南向穿越:识别、认领、速度估计、物理积分全部发生在 guest 内存;
过边界的只有像素变更(任何动画都付)与每触点一次的核内命中。

结构性保证(引擎侧的复杂度承诺):

```
手势泵          O(contacts + recognizers)/tick,稳态零分配(8 槽定长池)
scroller        O(1)/tick,纯字面量常量,IEEE 位一致
VirtualList     O(visible),窗口 memo 引用稳定
命中解析        O(新 contact × 树深),仅落下帧;无触摸 = 零
wire            ≤8×u32 电平快照 + 并行事实数组
```

## 10. 该记住的五件事

1. 先不用 Touch API:`Focusable onPress` + `TextField` + `VirtualList`
2. 自定义交互才用 `createGesture`,理解**认领**一个概念
3. 自定义滚动物理用 `createScroller`,绑 `translateY: -offset()`
4. 分支只写在 `hasFeature("input.touch")`,且仅当习语不同
5. 手感用 journey/tape 断言,和逻辑一样

`createKeyboardTouch` from `@pocketjs/framework/osk` tracks contact-owned space
and backspace holds without assigning focus to character keys. The keyboard
view supplies contact geometry and virtual time. **Release clears the hold**;
backspace repeats at most twice per step, and a held space enters caret dragging.
The view owns key-cap feedback, character insertion, layout and modality.
