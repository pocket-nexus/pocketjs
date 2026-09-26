# Pocket Manga

**Companion 管理源、下载、书库与图片处理。Pocket Relay 传输资源、订阅和进度操作。终端保留阅读交互和缓存。** 与 Pocket Map 一样，Manga 检测宿主的 `relayChannel`，存在时采用 Relay，否则采用 `io.offload`。本地 `io.resource-pack` worker 执行缓存读写、解压、CRC 校验和图片格式准备。应用代码不调用设备网络 SDK 或图片解码器。

## 模块

| 模块 | 责任 |
| --- | --- |
| `apps/manga/companion.ts` | companion 启动、设备连接、配对文件、SD 导出 |
| `companion/sources.ts`、`network.ts` | MangaDex 与 JSON 源、URL 验证、下载上限 |
| `companion/import.ts`、`jobs.ts`、`job-worker.ts` | 独立进程导入、进度、取消、重试 |
| `companion/store.ts`、`lock.ts` | SQLite 书库与任务、书库写入锁 |
| `companion/server.ts`、`index.html` | 回环地址上的管理与预览界面 |
| `companion/provider.ts`、`provider-worker.ts`、`backend.ts` | 隔离进程中的资源读取与进度备份，供两种通道调用 |
| `companion/relay.ts` | Pocket Relay TCP 配对、资源应答、书库推送 |
| `relay-profile.ts`、`relay-client.ts`、`transport.ts` | 应用资源格式、终端 Relay 会话、宿主通道选择 |
| `bake.ts`、`archive.ts`、`pack-format.ts` | 目录/CBZ 解析、图片缩放、PRP 写入 |
| `client.ts` | 终端请求队列、重连、缓存目录、离线下载 |
| `model.ts`、`document.ts` | 几何、版本地址、有界元数据记录 |
| `app.tsx`、`viewer.ts`、`camera.ts` | 书库、章节、阅读相机与纹理需求 |

启动与操作说明见 [应用 README](../apps/manga/README.md)。

**Manga 复用资源调度、资源视图、图片组件、手势和虚拟时钟 API。**
页面相机、包格式和 `pack-client.ts` 适配器留在应用目录，不新增框架公开子路径。
共享层增加图片票据的释放、3DS 后台缓存、进度存储与 Relay 在 QuickJS 的兼容处理。

## companion 持久化

默认根目录为 `.pocket/manga-relay/`，可通过 `--root` 改变。

- `manga.sqlite` 保存源、作品摘要、任务、设备进度和待拼接的进度记录。数据库使用 WAL。
- `packs/` 保存预处理版本与目录包。发布目录之前，版本包必须写入完成。
- `.relay.lock` 限制同一书库只有一个发布进程；provider 使用独立的 SQLite 连接。
- `import-*` 是导入临时目录。导入运行在子进程中，完成或子进程退出后清理。重启将未完成任务标为失败，用户可重试。
- `pairing.key` 是应用配对密钥。管理 HTTP 默认绑定 `127.0.0.1:8743`；Relay 默认监听 `127.0.0.1:8742`。Relay 在 HELLO 前读取并校验 64 字符配对密钥，认证后授予 `pocket-manga` 访问权。3DS offload 沿用按应用隔离的密钥文件。

**资源版本名包含作品身份、处理版本、元数据与下载内容的哈希。** 相同图片属于不同作品时不会复用另一作品的元数据；更新后的包不会覆盖旧版本的纹理地址。旧版本保留，直到用户在 companion 文件目录中清理不再使用的包。

## 资源格式

系列包保持原有 tile 地址：

```text
entry 0             系列元数据或文档头
entry 1             128×128 封面
entry 2..tileEnd-1   按页、层、行排列的 256×256 图片
entry tileEnd..     元数据分块（需要时）
```

元数据文档较小时，entry 0 保持旧版 JSON。较大时使用：

```json
{"document":1,"start":902,"count":4}
```

`start..start+count-1` 每条是 JSON 字符串，按序拼接后得到文档。**单条记录最多 1,800 UTF-8 字节，文档最多 256 KiB。** 写入器还检查 offload 响应与本地缓存写入请求各层 JSON 转义后的字节数。索引接受 v1/v2/v3；无 `pack` 字段的摘要沿用 `manga-<slug>`。

companion 的 `manga-index/0` 是 `{ "catalog": "mc-<hash>" }`。目录包采用上述文档格式。终端在目录记录写入后替换指针；中断不会使旧指针指向半份目录。

长页增加能装入 768×768 包围框的缩略层。阅读器同时保留缩略层和当前缩放层，**每层最多请求 12 块纹理**，页面 collection 上限为 28。旧长页包按可见窗口读取。相机初始化位于页首；横向翻页只在页面宽度不超过视口时启用。

## 终端缓存

3DS 的 `resourcePacks` 新增可选缓存操作，由 `apps/manga/pack-client.ts` 的 `resourcePackCache()` 封装：

- `text(pack, entry, text, callback)` 提交文本记录。
- `image(pack, entry, ticket, callback)` 从 offload 图像票据复制有界像素，调用者保留票据直到写入回复。
- `pixels(pack, entry, bytes, width, height, callback)` 将 Relay 的行序 RGB565 像素交给 native `cachePixels`，无需 offload 票据。最多保留 4 个待写入缓冲；取消、超时或 native 复制成功后释放队列引用。
- `remove(pack, callback)` 删除该包的网络缓存；已安装的 SD `.prp` 保留。

UI 线程只复制固定槽位。worker 执行格式转换、压缩、校验与文件操作。缓存记录为一条 entry 的 PRP，位于应用资源目录的 `cache/<pack>/<entry>.prp`。**缓存记录优先于安装包**，使 companion 目录可以更新旧 SD 索引。写入先生成 `.partial`；FAT 替换期间保留 `.bak`，读取可恢复该备份。

终端用 LRU 保留已从 SD 读出或收到写入确认的文本，**最多 32 条，字符串、键与记录开销的计费上限为 64 KiB**。同一来源和地址的并发元数据读取共用请求。刷新书库时确认远端指针，目录版本记录从本地读取；内容未变的指针不写回 SD，重启后也遵循此规则。远端记录写入失败时不进入该缓存，下一次刷新会重试。资源宿主会话更换和作品缓存删除会使对应内存记录失效。

**在线图片在 SD 写入确认前交付给渲染器。** 同一会话、同一地址的阅读和下载共用请求与像素，最多保留 4 张图片和 24 个消费者票据。每个消费者拥有独立票据；SD 写入确认和所有消费者释放后才回收底层像素。取消一个消费者不会中断其他消费者。写入失败会报告错误，已收到的图片仍可显示。

完整下载逐条校验已有记录，缺失时请求 companion，写入成功后继续。只有全部记录成功，才更新 `manga-saved` 指针与完成标记。**完整离线标记每次从 SD 检查，不用内存文本缓存代替。** `manga-saved` 是独立的完整离线目录：离线时优先采用该目录的版本，在线时采用 companion 新版本并保留被 companion 移除的离线作品。

删除作品缓存时阻止该版本的新写入，等待已提交的写入确认，再删除完成标记、更新离线目录、删除页面记录。原生 worker 接收的写入不会随 JS 请求取消而停止，因此删除不能跳过这个等待。

缓存不包含源凭据和图片原件。终端没有缓存的页面显示缺页提示；不能以目录存在判断漫画已经下载完成。用户在作品页删除缓存释放空间，**SD 上的作品没有自动淘汰策略**；内存 LRU 淘汰不会删除 SD 记录。

## Relay 资源与预算

Manga 使用 **Pocket Relay PR #456** 的公共实现，profile 为 `manga.library` v1，app grant 为 `pocket-manga`。Companion 书库服务不属于 Relay 框架。

| 资源 | namespace / key | kind / rendition | revision |
| --- | --- | --- | --- |
| 书库指针 | `manga/catalog` / `library` | EVENT / `catalog-v1` | 当前 `mc-<hash>` |
| 包记录数 | `manga/records` / 包名 | FILE / `pack-v1` | `file-<文件指纹>` |
| 元数据记录 | `manga/records` / `包名/entry` | FILE / `record-v1` | `file-<文件指纹>` |
| 图片 | `manga/records` / `包名/entry` | TEXTURE / `rgb565-v1` | `file-<文件指纹>` |

Companion provider 的 LRU **最多保留 256 条资源，计费上限为 8 MiB**，缓存内容包括已校验的文本和转换后的 RGB565 像素。每次请求比较文件的设备号、inode、大小及纳秒级修改时间与变更时间；文件替换、改写或删除会使旧结果失效。指纹来自读取内容的同一个文件描述符，避免原子替换期间把旧内容与新版本混用。条件读取命中时不重复解压、像素转换或向 Relay 进程传输图片。超过预算的单条资源不进入 LRU。

Companion 网页图片使用 ETag；未变化的预览返回 304，不重复生成 PNG。`mg-<32 位内容哈希>` 的图片 URL 使用一年缓存；旧式同名包需要重新校验，替换后会返回新图。

书库 stream 使用 latest-snapshot 订阅。Companion 每秒读取已发布的书库指针；变化后推送新指针，发送受阻时在下一次检查重试。终端读取所指目录后保存本地指针。不可变包使用另一个 stream，两个 stream 在握手窗口内分配接收预算，避免首个 stream 占满窗口。

**图片最多 128 KiB，文本对象最多 4 KiB。** 图片使用 R5G6B5LE；元数据记录包装为 JSON 字符串，文档中的浮点缩放值不受 Relay 元数据整数语法影响。终端只在持有文本值时发送 `ifRevision`，按 LRU 保留最多 8 条协议文本；图片最多占 4 个请求/暂存位置，交付到资源 collection 后由该 collection 管理纹理。CANCEL 撤销请求，迟到的图像不会进入暂存表。会话更换使旧 OPEN 和订阅回调失效。

进度使用协商后的 `x.manga.library.progress` 幂等操作，调用同一套持久化进度拼接逻辑。终端 Relay 的超时在帧边界按时间检查，不依赖 QuickJS 的微任务计时器；UTF-8、十六进制和 JSON 编解码不依赖浏览器或 Node 全局变量。

**3DS/PSP 当前未发布原生 Relay L0 通道。** 这些宿主走已有 offload；终端的 Relay 选择、缓存和无浏览器全局变量的启动通过编译后的 guest 测试验证。

## 请求与恢复

offload 适配方法固定为 `manga.read`、`manga.image`、`manga.describe`、`manga.progress` 和 `manga.progress-part`。设备只传包名、entry 地址或进度记录；在线源 URL、下载与源解析留在 companion。包名与 entry 在 provider 和 native worker 两侧验证。

offload 请求受 8 个槽位、每帧提交/交付和响应大小上限约束。3DS 在收到首个二进制图片响应时分配 1 MiB 图片槽池，只传文本的应用不分配该池。Relay 使用协商后的窗口、对象暂存和请求预算。客户端拥有 24 个待执行操作的上限；取消或关闭阅读器会返回图像票据。图片缓存失败会显示错误，但不会阻止已收到的在线图片显示。完整下载遇到写入失败会停止，不能生成完成标记。

**进度先写终端，再按设备身份备份到 companion。** `state.ts` 在宿主提供
`data.fs` 时使用已有文件系统 API：写入临时文件，全部分块成功后重命名为
`state.json`。中途失败保留上一份进度。3DS 使用按应用隔离的有界状态文件，
旧 `state.json` 和设备身份保持可读。 `updated` 在重启后从保存值与当前时间继续递增。单个作品的进度分成有界请求，companion 在拼接并校验后提交。重复和过期保存不会覆盖同一设备的新进度。不同设备保留独立记录。此机制不执行跨设备进度合并。

## 验证边界

Bun 测试覆盖实际配对 TCP Relay、隔离 worker、分块图像、条件读取、书库推送、取消与认证关闭，并覆盖源目录、请求边界、后台导入、真实图片烘焙与 PRP 回读、SD 导出、重启、目录中断、写入失败、离线版本保留和票据回收。原生 C fixture 执行实际的 asset worker，使用 AddressSanitizer/UndefinedBehaviorSanitizer 验证读写、缓存覆盖、删除、CRC 和代际隔离。进度存储 fixture 验证备份恢复。

完整 `.3dsx` 构建验证 C/Rust/QuickJS 连接；编译后的 guest 可通过模拟 host 检查按键、排序和保存行为。**这些检查不代表 3DS 真机帧率、SD 性能或触摸手感已验收。** 当前宿主没有通用 CJK 字形缓存，终端标题仍受烘焙字体覆盖范围限制。
