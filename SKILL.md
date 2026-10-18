---
name: au-fishing
description: 澳洲（NSW）钓鱼助手 — 潮汐/风/涌窗口排名 + 卫星检测的沙滩沟槽位置 + NSW 鱼种尺寸/袋限 + 钓获记录。当用户问什么时候去钓、站在沙滩哪儿、潮水怎么样、这条鱼够不够尺寸、能留几条、或要记录钓获时使用。
---

# au-fishing

一个**数据管道 + 可解释打分**的技能，不是鱼获预测器。它把「潮汐什么时候在动、天亮天黑、风多大、涌多高」拼成时间轴，再按固定权重排出窗口，并把人能质疑的原始数字一起给你。

## 何时使用

- 「这周哪天适合去钓鱼？」「明天早上涨潮几点？」
- 「Collaroy 附近有什么钓点？」
- 「涌浪 1.5m 还能上礁石吗？」

不适用：需要真实鱼获统计、船钓航次、商业渔业配额的问题。

## 命令

脚本位置固定，从技能目录执行：

```bash
cd ~/.dsh/skills/au-fishing

# 条件 + 窗口（需要 WILLYWEATHER_API_KEY）
node scripts/fishing.mjs conditions --at "Collaroy Beach" --days 3
node scripts/fishing.mjs conditions --at 2212 --days 3 --json

# 钓点结构（不需要 key，走 OSM/Nominatim）
node scripts/fishing.mjs spots --near "Collaroy Beach, NSW" --km 8

# 离线自测（无需 key，用内置 fixture 验证打分链路）
node scripts/fishing.mjs conditions --fixture fixtures/collaroy-2day.json
```

```bash
# NSW 鱼种规则：查表 / 判断一条鱼合不合规
node scripts/fishing.mjs species --q flathead
node scripts/fishing.mjs species --legal "dusky flathead" --size 42

# 钓获记录（写入 data/catches.jsonl）
node scripts/fishing.mjs catch --species "Dusky Flathead" --size 42 --spot "Narrabeen Lake" --tide falling

# 统计（描述性，不是校准）
node scripts/fishing.mjs stats

# 卫星检测的沙滩沟槽（surf-sat）
node scripts/fishing.mjs gutters --at "Collaroy Beach" --km 1 --confirmed

# 本地点位（人工鱼礁、FAD、沉船、你自己的私房点）
node scripts/fishing.mjs marks
node scripts/fishing.mjs marks add --name "..." --lat -33.85 --lng 151.30 --type reef --depth 38
```

`--at` 接受地名或 WillyWeather location id（纯数字）。`--json` 给机器读的完整结构，文本模式给人读的表格。

## 数据源（两级，自动降级）

| 情况 | 用到的源 | 拿得到什么 |
|---|---|---|
| 设了 `WILLYWEATHER_API_KEY` | WillyWeather v2 | 潮汐 + 风 + 涌 + 日月，**完整** |
| 没设 key | Open-Meteo（marine + forecast） | 风 + 涌 + 日出日落；**没有潮汐**，分数会按可用项重新归一化 |
| 两种情况都有 | NSW SEED ArcGIS REST | 海洋保护区/禁钓分区（按坐标实时查） |

没 key 时不要报错就完事——照样能出风和涌的报告，只是要明确告诉用户「这版没有潮汐，设 key 才有潮流窗口」。**任何情况下都不要编造数据。**

## 怎么读输出

每天一块：潮汐事件与振幅、最大风、最大涌浪+周期、日出日落月相，然后是窗口表。

窗口表的「主导」列是**加权后**贡献最大的因素（潮水 35% / 光线 30% / 风 20% / 涌 10% / 潮差 5%）。「峰值」是窗口内最高分的那个 30 分钟槽位。

转述给用户时：

- 说清**为什么**这个窗口好（涨/落潮中段水在动 + 贴近日出/日落），不要只报分数。
- 分数 < 55 的窗口不输出，如果没有窗口就直接说「这天没有明显窗口」，不要硬凑。
- ⚠️ 行必须原样转达（涌浪 ≥2m、风 ≥25km/h、无潮汐数据）。

## 沟槽（"站在沙滩哪儿"）

`data/gutters.json` 来自 `~/surf-sat` 的 v3 检测器：从 ESRI 卫星影像找沙滩上的沟槽（gutter），**先用 OSM 的岩礁/崖壁/岩池/丁坝数据把硬质结构排除掉**再做检测。

- `confirmed`：在多次独立卫星拍摄的同一位置都检出（`dates`/`nDates`）
- `single`：只检出一次，**是线索不是结论**

回答"去哪钓"时：先看 `gutters`，再看 `spots`。沟槽是沙滩钓的核心地形，人工鱼礁对岸钓基本无用。

**必须说清的两件事**：① 单次检出不等于存在；② 排除区大的海滩（岩岸为主）检出 0 个，不代表没有沟槽，只代表没得评估。

## 鱼种规则（NSW）

`data/species.json` 是**从 NSW DPIRD 官方页转录**的，63 条，覆盖常见海水鱼 + 主要无脊椎动物。字段：`minCm` / `maxCm` / `bagLimit` / `possessionLimit` / `closedSeason` / `protected` / `notes`。

回答"这条能不能留"时：

- 一律用 `species --legal`，**不要凭记忆报数字**。这份表存在的意义就是替代记忆。
- `bagLimit: 0` 或 `protected: true` 是禁捕（Eastern Blue Groper、wobbegong 等）。
- 标了 `grouped: true` 的，袋限是**组合上限**，不是每种都能拿满。比如 Flathead 三种合起来有各自规则，别把 5+10+10 加起来。
- 未列出的鱼默认袋限 20，这一条要主动告诉用户。
- 表有 `asOf` 日期。用户如果拿着卡在尺寸线上的鱼问，提醒回原页复核 + 鱼获会缩水。

## 钓获记录

`catch` 追加到 `data/catches.jsonl`，一条一行。如果鱼名能匹配到规则表且给了尺寸，会**当场跑合规判断**（不合规还标"留下"会警告）。

`stats` 输出按鱼种/钓点/时段/潮态的分布。这是**描述性统计，不是权重校准**——样本少于 30 条时不要拿它去改 `WEIGHTS`，也不要向用户暗示"系统在学习"。

## 本地点位

`data/reefs.json` 是官方点位（公开）；`marks add` 默认写入 **`data/reefs.local.json`**（已 gitignore，私房点不会泄露）。加 `--public` 才写进公开文件。**没有预置任何人工鱼礁坐标**——NSW DPI 公布了，但站点反爬（Cloudflare 403 + reader 代理也 403），无法可靠转录，所以留空并开放 `marks add`。用户提供坐标时才录入，标 `verified: false`。

`spots` 会合并"本地点位 + OSM"，且 **OSM 挂掉时只显示本地点位而不是报错**。

## 澳洲特有的坑（这些是美国工具踩过的）

1. **单位**：一律米 / km·h / 摄氏。脚本会在 API 忽略 `units` 参数时自动把 ft、mph 换算掉。
2. **潮高基准不通用**：WillyWeather 用自己的基准面，**不能**和 NOAA 的 MLLW、也不能和别的国家潮汐表直接比数值。只比同一 location 的相对变化。
3. **不是每个 location 都有潮汐**：`typeId` 决定可用预报类型（潮汐：2–16,19；涌浪：2,5–13,24,25）。没有潮汐数据的地点，脚本会给出警告并跳过潮水项。
4. **南半球**：月相视觉左右反转，但光照百分比相同；以 API 返回的 `hemisphere` 字段为准，别自己按北半球画。
5. **离岸/向岸风**：脚本不判断海岸朝向。同样是 NE 风，在 Collaroy（朝东）是侧吹，在 Pittwater（朝南的内湾）就完全不同。转述时要结合钓点朝向说，别只报风速。
6. **执照**：NSW 现在**需要**休闲钓鱼执照（3 天 $7 / 1 月 $14 / 1 年 $35 / 3 年 $85，[Service NSW](https://www.service.nsw.gov.au/services/recreational-fishing-licence)）。其他州各不相同。用户若是新手或第一次去，提醒一句。
7. **禁钓区**：NSW 的 Marine Park 分区已经接进脚本（`PUBLIC/Marine_Protected_Areas`，311 个分区，7 种 zone 类型）。`Sanctuary Zone` 和 `Aquatic Reserve (Sanctuary)` 是禁钓，其余是限制类。脚本按坐标点查，输出里带 🚫 / ⚠️。**但**：这只是 NSW 的数据，其他州没有接入；而且定位靠地名解析，落在边界外会漏报，用户报具体坐标时可以手动核。

## 安全

涌浪 ≥ 2m 时明确劝阻上岩石平台和外侧防波堤（澳洲岩石钓溺亡事故主要就是这个组合）。给出替代方案（内湾、栈桥、河口），而不是只丢一个警告。

## 边界

- 分数是启发式，是**排窗口的工具**，不是咬钩概率。被问到「一定能钓到吗」时明确说不能保证。
- 鱼种表只覆盖 NSW 且是**转录**的；其他州没有。
- `stats` 只做描述，不做统计推断，也不会自动改权重。
- 不要为了好看而省略警告行或补造数据。

## 数据来源与许可

- NSW DPIRD 海水袋限/尺寸页（手工转录，CC-BY），数据截至 2026-10-18。
- 沟槽点位：本地项目 `~/surf-sat`（ESRI World Imagery 派生，OSM 掩膜），见其 `GUTTERS_V3.md`。
- WillyWeather API v2（潮汐/风/涌/日月），需要个人 key。
- Open-Meteo marine + forecast API（风/涌/日出日落），免费无 key，CC-BY 4.0。
- NSW SEED ArcGIS REST：`spatial.industry.nsw.gov.au/.../PUBLIC/Marine_Protected_Areas/MapServer/0`，CC-BY 4.0。
- OpenStreetMap Overpass + Nominatim（ODbL），钓点结构未验证公众可达性——悉尼的 `man_made=pier` 里混有私人码头，脚本已过滤 `access=private`，但不能保证全干净。
- 打分与结构借用自 [Volare-Consulting-Software/fishon](https://github.com/Volare-Consulting-Software/fishon)（MIT）的思路（双层输出、haversine + 聚类去重）；潮汐 provider、法规库、抓取器均为美国专用，未沿用。详见 `README.md`。
