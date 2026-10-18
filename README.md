# au-fishing

澳洲钓鱼条件 CLI + 技能。零依赖（Node ≥ 18），数据来自 WillyWeather v2 与 OpenStreetMap。

## 安装

```bash
# 1) 申请 key（免费额度够个人用）
open https://www.willyweather.com.au/api/register.html

# 2) 导出
echo 'export WILLYWEATHER_API_KEY=你的key' >> ~/.zshrc && source ~/.zshrc

# 3) 冒烟测试（不需要 key）
node scripts/fishing.mjs conditions --fixture fixtures/collaroy-2day.json
node scripts/fishing.mjs spots --near "Collaroy Beach, NSW" --km 8
node scripts/fishing.mjs conditions --at "Collaroy Beach, NSW"   # Open-Meteo 降级模式
```

**没有 key 也能用**：`conditions` 会自动降级到 Open-Meteo，给风和涌 + 日出日落，不打潮汐分。

## 功能

| 命令 | 作用 | 需要 key |
|---|---|---|
| `conditions` | 潮汐/风/涌/日月 + 30 分钟粒度窗口排名 | 否（降级） |
| `spots` | 本地点位 + OSM 结构 + 禁钓区标注 | 否 |
| `species` | NSW 63 种海水鱼的尺寸/袋限/禁渔期，含合规判断 | 否 |
| `catch` | 钓获记录，写入 jsonl，当场判断合规 | 否 |
| `stats` | 钓获的描述性统计 | 否 |
| `marks` | 管理本地点位（鱼礁/FAD/沉船/私房点） | 否 |

## 用法

```bash
node scripts/fishing.mjs conditions --at "Collaroy Beach" --days 3
node scripts/fishing.mjs conditions --at 2212 --days 3 --json
node scripts/fishing.mjs spots --near "Narrabeen, NSW" --km 5 --json
```

## 从 FishOn 借了什么、没借什么

FishOn 是个写得很干净的项目（DI 容器、provider 接口、MCP 双传输），但**数据层全是美国**。逐块判断如下：

| FishOn 模块 | 能否用于澳洲 | 处理 |
|---|---|---|
| `mcpServer.ts` 的 6 个工具切分 | ✅ 思路可复用 | 收敛成 2 条命令（conditions / spots），不照搬 6 个工具 |
| `dualContent()`：人读表格 + 机器 JSON | ✅ 完全通用 | 直接沿用这个模式（`--json` vs 文本） |
| `haversineMiles` + 0.5mi 聚类去重 | ✅ 通用 | 改成 km，阈值 150m，用于合并「同一栈桥的 node + way」 |
| `publicDataFishingSpotProvider` 的 OSM 部分（pier/breakwater/leisure=fishing） | ✅ OSM 全球有效 | 保留并加 `groyne`、过滤 `access=private` |
| 同上，ArcGIS 人工鱼礁部分 | ❌ 绑美国州级数据集 | 丢弃 |
| `NoaaTideProvider` | ❌ 只有美国站 | 换成 WillyWeather `tides` |
| `synodicMoonPhaseProvider` | ⚠️ 数学没错，但 | 不用——WillyWeather 直接给月相+月出月落，且带 `hemisphere` |
| `weatherScraper`（Playwright 抓 FishWeather） | ❌ 美国站、易碎、违反 ToS 风险 | 丢弃 |
| `fishRulesApiClient` / `regulationsProvider` / `seasonStatus` | ❌ 绑美国 Fish Rules 法规库 | 丢弃；澳洲法规不开放 API，留给用户自查 |
| `forecastRow` 的 **AM/PM 分桶** | ❌ 不该沿用的设计 | 见下 |

### 为什么丢掉 AM/PM 分桶

FishOn 把每天压成 AM/PM 两行，是因为它抓的 FishWeather 页面**只有 AM/PM 粒度**——数据源的限制被写进了领域模型。

WillyWeather 给的是小时级 wind/swell 和事件级 tides。保留 AM/PM 等于继承一个不存在了的约束，而且会把「日出前 40 分钟」和「上午 10 点」压成同一格，恰好抹掉最关键的清晨窗口。

所以这里换成 **30 分钟时间轴 + 潮汐插值**：潮位在事件间线性插值，流速按 `峰值 × sin(πp)` 建模（高/低潮处为 0，半程最大），这样「平潮」和「流最急」在时间轴上自然浮现。

### 分数怎么来的

```
score = 100 × ( 0.35·潮流 + 0.30·光线 + 0.20·风 + 0.10·涌 + 0.05·潮差 )
```

| 项 | 归一化方式 | 理由 |
|---|---|---|
| 潮流 | 当天最大流速的 85% 记满分 | **绝对阈值不可移植**：悉尼 1.3m 潮差的峰值流速约 0.2 m/h，顶潮区 4m 潮差能到 0.6 m/h。用「今天自己最好的一段」做分母才跨地点可比 |
| 光线 | 距日出/日落 ±2h 线性衰减 | 低光摄食是跨鱼种最稳的经验规律 |
| 风 | ≤10km/h 满分，≥30km/h 归零 | 影响抛投与压线，与鱼口的关系弱于前两项，故权重低 |
| 涌 | 1.0m 满分，向 0 与 3m 两侧衰减 | 适度浪涌是好事，太平或太大都不好 |
| 潮差 | 1.8m 满分 | 大潮（朔望）水交换量大，proxy 用当天振幅 |

权重是**故意写死的常量**，不是拟合结果。目的是让人能说「我觉得风向比潮水重要」然后自己改 `WEIGHTS`——而不是给出一个不可质疑的黑箱。

## 修正：两处我一开始判断错了

初版 README 写「法规库和 ArcGIS 数据集澳洲没有对应源」——这是按「美国专属」直接排除，没有去查。实际都有，只是形态不同：

| 我原来的判断 | 实际 |
|---|---|
| ArcGIS 人工鱼礁数据集 ❌ 澳洲没有 | **半错**。NSW 有整套 ArcGIS REST（`spatial.industry.nsw.gov.au`）：311 个海洋保护区/分区、Key Fish Habitat、牡蛎礁、Recreational Fishing Havens。**但没有人工鱼礁图层**——礁体和 FAD 点位只以网页/PDF 发布，且站点挡爬虫（403）。所以「有替代平台、没有替代数据」 |
| Fish Rules 法规 ❌ 澳洲没有 | **半错**。NSW DPI 有完整规则页（bag/size limits），但没有开放数据：data.nsw 和 SEED 都搜不到结构化数据集，规则实际写在 Fisheries Management (General) Regulation 的附表里。全澳没有 Fish Rules 那种可直接调用的接口 |
| Playwright 抓 FishWeather ❌ 美国站 | **错在理由**。替代品一直有：Open-Meteo Marine（已验证可用、免费、无 key、CC-BY 4.0）。顺带查了 BOM——它有公开 JSON API，但返回体里明确写着 "You must not use, copy or share it"，所以**不能用**；BOM 的合规路径只有注册数据服务 |

已经落地的两项：

1. **禁钓区检查**（`mpaAt()`）：每个钓点和 `conditions` 的定位点都会查一次 ArcGIS 分区，`Sanctuary Zone` / `Aquatic Reserve (Sanctuary)` 标 🚫，其余限制类标 ⚠️。服务挂掉只降级成空数组，不影响主流程。
2. **Open-Meteo 降级**（`openMeteoPayload()`）：没有 WW key 时把 Open-Meteo 的 hourly 数据组装成 WillyWeather 形状的 payload，后面 `buildDays`/评分链路完全复用。此时权重会按可用项重新归一化——否则缺了 35% 的潮流项，所有分数都会卡在 60 分左右，含义就变了。

## 数据可信度

| 数据 | 来源 | 可信度 |
|---|---|---|
| 鱼种尺寸/袋限 | NSW DPIRD 官方页转录（2026-10-18） | 高，但**会变**；边界鱼回原页复核 |
| 海洋保护区分区 | NSW SEED ArcGIS REST | 高，实时查询 |
| 潮流/风/涌 | WillyWeather / Open-Meteo | 高 |
| 钓点结构 | OpenStreetMap | 中，未验证可达性 |
| 人工鱼礁坐标 | **无** | 未收录，见下 |

## 仍然没有的

- **人工鱼礁 / FAD 坐标**：NSW DPI 有公布，但只在网页和 PDF 里。`dpi.nsw.gov.au` 和 `dpird.nsw.gov.au` 直连 403，`r.jina.ai` 代理读规则页成功、读鱼礁页也 403，规划门户的 PDF 能下载但没有 PDF 解析库。**结论：不编造坐标**，留 `marks add` 让用户录入（或用户把 DPI 页面上的坐标贴过来，我批量导入）。
- **bag/size limit 结构化数据**：全澳无开放接口，链接给人。
- **实时波浪浮标**：data.nsw 上只有指向 ENV 网站的链接，没有 API；MHL 的 MHLADAS 是要订阅的。
- **其他州**：目前只接了 NSW 的分区。VIC/QLD/WA 各有各的 portal，没做。

## 点位数据放哪

| 文件 | 内容 | 是否公开 |
|---|---|---|
| `data/reefs.json` | 官方鱼礁/FAD 坐标（DPI PDF 转录） | 会提交，公开 |
| `data/reefs.local.json` | 你自己的私房点（`marks add` 默认写这里） | **已 gitignore，不会上传** |

想把点位贡献到仓库才用 `marks add --public`。

## 已知限制

- **不判断海岸朝向**：NE 风在朝东的海滩是侧吹，在朝南的内湾是顺风。脚本只有坐标，没有岸线法向量。
- **不解潮汐调和常数**：插值是线性的，真实潮汐曲线在高低潮附近更平缓；流速模型是正弦近似，用于排序够用，不能当流速仪。
- **Overpass 公共实例不可靠**：官方明确说公共端点「面向浏览器交互，不适合自动化」，高频调用会被限流，返回 502/500。脚本试三个实例并记住可用的那个，全挂时给明确报错。需要稳定就自建实例并设 `AF_OVERPASS_URL`。2026-10-18 实测：三个公共实例同时不可用。
- **OSM 覆盖不均**：悉尼 `man_made=pier` 里私人码头很多（已过滤 `access=private`），且不保证公众可达。
- **不含鱼种 / 法规 / 禁渔期**，也不含船钓与离岸。
- WillyWeather 免费额度有限，`--days` 别开太大。

## 许可

代码 MIT。打分与结构思路源自 [fishon](https://github.com/Volare-Consulting-Software/fishon)（MIT），已在上表标注取舍。OSM 数据 © OpenStreetMap contributors，ODbL。
