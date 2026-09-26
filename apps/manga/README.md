# Pocket Manga

Pocket Manga 的 **companion 是电脑端应用**，负责在线源、下载、转码、章节、书库和进度备份。**Pocket Relay 是 companion 与终端之间的资源协议**，与 Pocket Map 使用同一实现。终端负责阅读交互、纹理显示和本地缓存；companion 关闭后仍可阅读已保存的漫画。

## 启动 companion

需要 Bun，以及 `ffmpeg`/`ffprobe` 或 ImageMagick。CBZ/ZIP 使用内置解包器，无需 `unzip`。

```sh
bun install
bun apps/manga/companion.ts
```

打开 <http://127.0.0.1:8743>。默认书库位于 `.pocket/manga-relay/`，可用 `--root /path/to/library` 指定。管理界面绑定回环地址；导入工作在独立进程中运行。关闭或重启 companion 后，源、书库和任务记录保留。

- **添加源**：输入 `https://mangadex.org`，或下文的 JSON 源目录 URL。
- **浏览源**：搜索作品，选择语言和章节范围，然后导入。语言使用 MangaDex 代码，例如 `en`、`ja`、`zh`、`zh-hk`。
- **链接导入**：粘贴 MangaDex `/title/<uuid>` 作品链接，或 `.cbz` / `.zip` 下载地址。
- **我的书库**：查看封面、在浏览器阅读、移除作品。移除源不会删除已导入的漫画。
- **导入任务**：查看阶段、取消、重试。重复提交同一个进行中的任务会返回已有任务；完成后再次导入用于更新作品。

支持的是上述源接口，**不是任意漫画网页解析器**；不能加载 Mihon/Tachiyomi 的 APK 扩展。重定向、下载体积与解压后的体积有上限。自建源位于本机或局域网时，启动时添加 `--allow-private-sources`。

## Pocket Relay 与宿主支持

Companion 的管理网页默认使用 **127.0.0.1:8743**，Pocket Relay TCP 监听默认使用 **127.0.0.1:8742**。`--port`、`--relay-port` 和 `--relay-host` 分别控制这些地址。旧入口 `bun run manga:relay` 保留，数据目录和 `.relay.lock` 文件名保留；升级不需要移动现有书库。

终端检测宿主的 `relayChannel`：存在时用 Pocket Relay，不存在时用 offload。Relay 提供书库订阅、资源版本与条件读取、分块图片、请求取消，以及进度备份操作。连接在 HELLO 前校验 64 个十六进制字符的配对密钥；此 TCP 试点不加密。需要网络上的 Relay 宿主访问时可指定 `--relay-host 0.0.0.0`。

**PR #456 的 3DS/PSP 宿主尚未发布原生 Relay 通道。** 当前 3DS 使用下节的 offload 连接方式，选择规则与 Map 相同。实际 Relay TCP、编译后的 guest 和离线缓存链路有测试覆盖；构建 `.3dsx` 不代表真机已能通过 Relay 连接。

## 连接 3DS

停止已运行的 companion，再带设备地址启动。书库与任务记录保留。

```sh
bun apps/manga/companion.ts --device 192.168.1.42
bun tools/3ds.ts manga
```

启动日志会给出配对文件位置。首次运行会生成 `<companion root>/pairing.key`，将其原样复制到：

```text
sdmc:/pocketjs/offload/b4da3f33b88e66e6.key
```

然后启动 `dist/3ds/manga-main.3dsx`。设备和 companion 应位于同一可信局域网；offload 使用设备 TCP 8741，配对密钥按应用隔离，传输不加密。自定义配对文件用 `--key-file FILE`，端口用 `--device-port PORT`。设备在启动时读取密钥；复制后需要重启应用。

**不要求 companion 一直在线。** 缺少配对文件或网络时，应用仍会启动并读取本地资源。旧版本的 `manga-index.prp` 和 `manga-<slug>.prp` 保持可读。

## 缓存与离线阅读

- 在线阅读时，封面、元数据和读取过的图片分块写入终端缓存。图片收到后即可显示，SD 在后台写入；同一页的阅读和离线下载共用请求。
- 刷新时重新确认 companion 的书库指针，未变化的目录记录复用本地副本，不重复下载或写 SD。终端元数据 LRU 上限为 32 条、64 KiB；companion 解码资源 LRU 上限为 256 条、8 MiB。
- 在作品页按 **SELECT** 保存全部页面和缩放层；再次按 SELECT 取消。失败或中断后重试会跳过通过校验的本地记录。
- 只有全部记录写入成功，才显示 **SAVED OFFLINE**。看过某一页不等于保存了整个作品。
- 完整离线目录保留下载完成时的版本。companion 更新或移除作品后，旧离线副本仍在终端可用。
- 在作品页按 **START**，再按一次 START 确认，等待该版本待写入的记录完成，再删除网络缓存。通过 SD 导出安装的 `.prp` 文件不会被删除。
- 缺页、写入失败、磁盘空间不足会显示提示。缓存不会自动淘汰已保存的作品；需要释放空间时删除离线副本。

缓存位于 `sdmc:/pocketjs/assets/b4da3f33b88e66e6/cache/`。阅读进度保存在应用的 `state.json`，并在连接时按设备身份备份到 companion。离线阅读产生的进度在重连后补传；不同设备的进度分开保存，不以设备时钟决定跨设备覆盖。

## 导出 SD 包

没有网络，或希望批量准备 SD 卡时：

```sh
bun apps/manga/companion.ts export --out /media/SD/pocketjs/assets/b4da3f33b88e66e6
```

导出先复制版本包，最后发布索引。它不会删除目标目录中的旧包、进度或网络缓存。终端现有的缓存目录指针优先于 SD 索引；如果要让一次 SD 导出替换终端的在线书库快照，退出应用后移走 `cache/manga-index/`。`cache/manga-saved/` 保留独立的完整离线目录。

本地图片目录仍可使用原来的烘焙入口：

```sh
bun apps/manga/bake.ts --library ~/manga --out dist/manga
```

目录约定为 `<库>/<作品>/<章节目录或 CBZ>`，支持散图、自然排序、`ComicInfo.xml` 与 Mylar `series.json`。非 ASCII 目录会得到稳定 ID；同名 slug 冲突会报错。

## JSON 漫画源

将下面的 JSON 放到可访问的 HTTP(S) URL，然后在“添加源”中粘贴链接。图片和压缩包 URL 可以相对源文件解析。`id` 应保持稳定，章节与页面按数组顺序读取。

```json
{
  "version": 1,
  "name": "My comics",
  "series": [{
    "id": "demo",
    "title": "Demo Manga",
    "direction": "rtl",
    "chapters": [
      { "id": "1", "title": "Chapter 1", "pages": ["pages/01.png", "pages/02.jpg"] },
      { "id": "2", "title": "Chapter 2", "archive": "chapters/02.cbz" }
    ]
  }]
}
```

MangaDex 适配器依据其[官方 API 定义](https://api.mangadex.org/docs/static/api.yaml)读取目录、章节 feed 和 at-home 图片地址。外部跳转章节不会被当作可下载页面。

## 终端操作

| 界面 | 操作 |
| --- | --- |
| 书库 | UP/DOWN 选择，A/CIRCLE 打开，TRIANGLE 搜索，START 排序，SELECT 刷新 |
| 作品 | UP/DOWN 选章，A/CIRCLE 阅读，B/CROSS 返回，TRIANGLE 重试元数据，SELECT 保存/取消离线下载，START 两次删除网络缓存 |
| 阅读 | L/R 翻页，方向键/摇杆平移，ZL/ZR 缩放，SQUARE 切换适宽/适页/1:1，TRIANGLE 复位到页首，SELECT 书签，B/CROSS 返回 |
| 触摸 | 下屏封面选书、章节选读；阅读中点两侧翻页，拖动平移；多点宿主可捏合缩放 |

适宽时 LEFT/RIGHT 根据作品的 RTL/LTR 方向翻页；宽度超出屏幕时改为平移。3DS 的触摸屏是单点输入。非阅读界面的 SQUARE 切换夜色/纸色。

## 限制与验证

- 当前终端原生落点为 **3DS**；其他宿主需要实现 Relay 或 offload、资源包与缓存能力。Relay 图片持久化使用新增的 `cachePixels` 宿主操作；缺少此操作时可通过 SD 导出离线包。
- 终端烘焙字体没有完整 CJK 字形。companion 管理界面支持中文；终端的非 ASCII 书名可能缺字，可在链接导入时指定 ASCII 书名。
- 不支持 CBR/RAR/EPUB、无限纵向连读、账号登录源、跨设备进度合并。
- 每个版本最多 65,536 个资源记录；元数据文档最多 256 KiB；超长作品可分章节范围导入。每页解码画布有内存上限，高缩放层会受该上限限制。
- 图片原件不保留在 companion；导入完成后保留预处理版本包。更新会读取源；重试导入会重新获取源图片。旧版本包保留，避免正在阅读的终端失去资源。

```sh
bun test tests/manga-*.test.ts
bun test --conditions=browser tests/relay-*.test.ts tests/resource-pack.test.ts tests/resource-pack-view.test.ts tests/3ds-runtime-state.test.ts
bunx tsc --noEmit
bun tools/3ds.ts manga --pocket-only
bun tools/3ds.ts manga
```

协议与存储边界见 [docs/POCKET_MANGA.md](../../docs/POCKET_MANGA.md)，SD 格式与 GPU 缓存见 [native-cache.md](./native-cache.md)。
