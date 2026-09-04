# Immersive Japan Navigation — 作業の前提

このファイルはセッションをまたいで必ず読み込まれる。
会話が長くなって圧縮されても、ここに書いてあることは失われない。
**新しい制約や方針を受け取ったら、まずここに追記すること。**

関連文書:
- `docs/requests.md` … **利用者から受けた依頼の全記録**と対応状況。
  「前に何を頼まれたか」を思い出せなくなったら、まずここを読む
- `docs/pitfalls.md` … 一度はまって時間を使った落とし穴。着手前に該当箇所を読む
- `docs/worklog.md` … いまどこまで進んでいて、次に何が残っているか
- `docs/architecture.md` … 全体構成
- `docs/research.md` … 外部データと技術の調査結果（一次情報の URL 付き）

---

## 1. 会話の作法（利用者からの明示の指示）

- **必ず日本語で書く。** 返事も途中報告もコミットメッセージもすべて日本語。
- **中断せず最後まで続ける。** 途中で確認を挟んで止まらない。
- **URL は特別なものがあるときだけ出す。** 本番 URL（map-3d-sepia.vercel.app）は
  毎回貼らない。新しく作った API や、いつもと違うものだけ示す。
- **絵文字を使わない。** アイコンが要るところは SVG で描く。

## 2. 絶対に曲げない方針

### 地理的正確性が最優先
実在する建物・道路・線路・信号・樹木の **位置と形状を創作してはならない。**
出典は OpenStreetMap と PLATEAU。データが無いなら「出さない」が正解で、
それらしいものを生成するのは誤りとする。

補ってよいのは「一般的な設計基準で決まる寸法」だけ。
例: 床版の厚み、梁の高さ、柱の間隔と断面、車線の幅、レールの軌間。
これらは道路構造令・鉄道の建築限界といった公開されている標準値を使い、
根拠をコードのコメントに書く。

**推測してはいけないものの例:**
- 速度制限 … OSM に `maxspeed` があるときだけ表示する。標識の値の捏造は誤情報
- 建物や構造物の色 … 「コンクリート」「鋼」など材質の一般色に留める
- 施設の名称・営業時間・電話番号

### データの優先順位

最初の仕様で明示されている順序。迷ったら上から使う。

```
1. 実際の GIS データ
2. OpenStreetMap
3. PLATEAU
4. 国土地理院
5. その他、利用条件を満たす公開データ
6. AI 生成データは「不足する視覚的アセットの補完」のみ
```

AI 生成を使ってよいのは、木・街灯・標識・ベンチ・自動車・小物など
**位置が地図の正確さに関わらないもの**に限る。
（現状 AI 生成アセットは 1 つも使っていない。街路樹も街灯も信号も、
OSM の実在位置に公開されている設計基準の寸法で組み立てている）

### 禁止事項

最初の仕様の第 29 節。**例外なし。**

- Google Maps のコードやデータをコピーする
- Google の非公開 API を解析して利用する
- Google Maps の 3D データをスクレイピングする
- Google の UI をそのままコピーする
- 実在建物を AI で勝手に捏造する
- **ライセンス不明の 3D モデルを利用する**
- API キーを Git に保存する
- 日本全国の巨大データを初回ロードする

### 秘密情報
API キーをフロントエンドのコードに置かない。すべて環境変数（`.env.example` に雛形）。
Vercel の MCP コネクタは **読み取りのみ** で使う。

### 想像で実装しない

> 不明な仕様を勝手に想像して実装しない。公式ドキュメントを優先する。

Cesium / PLATEAU / OpenStreetMap / Valhalla / PostGIS は、
**現在の公式仕様を確認してから**書く。
外部サービスの応答の形は、**実際に叩いて確かめてから**解釈する。

実際にこれで助かった例:
- OSRM の車線案内は公開デモを叩いて形を確認してから実装した。
  一方 Valhalla は公開デモが 503 で確認できなかったので、
  **推測で解釈せず未対応のままにしてある**（誤った矢印は運転中に危ない）
- PLATEAU の LOD1 に `bldg:usage` が入っていることは、
  b3dm のバッチテーブルを実際に開いて確かめた

「調べる」ことは何度も促されている（「考えるだけでなく多く調べて」
「外部サイト複数を参考に」「最新情報とかも調べて」
「類似事例や Web ゲームの技術を調べて応用して構わない」）。
検索は遠慮せずに行ってよい。

### 作ったら自分で監査する

「完成後、自身で再監査し最高品質に向上してください」という指示がある。
実装して動いたら終わりにせず、**測って確かめてから**次へ進む。
測る道具は `npm run survey:*` と `npm run measure:*` に置いてある。

### 色
「3D モデルは色も事実どおりでリアルに」という指示がある。
テクスチャがある LOD2 はテクスチャを活かし、無いところは
用途（`bldg:usage`）ごとの一般的な色で塗る。派手な着色はしない。

## 3. 目指す水準

Google マップのイマーシブビュー、Yahoo! カーナビ、市販カーナビと
**同程度の機能性・利便性・品質・完成度**。見た目だけでなく操作感も含む。

- 最重要地域は **浜松市（旧中区）**。ここを完全再現の基準とする
- iPhone（17 を想定）ではネイティブアプリのような見た目と操作感にする
- FPS が 20 を切らないこと。「セーフモードでも重い」という指摘を受けた経緯がある

## 4. 軽量化の考え方

**部品を減らす・精度を下げる以外の方法を先に使い切る。**
利用者から明示的にそう言われている。

先に試すもの:
1. 無駄な取得をなくす（重複するタイルセット、範囲外のデータ、使わないアセット）
2. まとめて描く（GeometryInstance のバッチ化、単一 Primitive 化）
3. 描かなくてよいものを描かない（カリング、`requestRenderMode`）
4. 距離に応じた連続的な詳細度（段階的に切り替えると境界で目立つ）
5. 取得の順序と時期（起動時に集中させない、遅延読み込み）

そのうえで足りなければ、間引きを **2 の冪で** 行う。
半端な比率で間引くと、詳細度が戻ったときに部品が横滑りして見える。

## 5. Swift への移行を見据えた層分け

将来 Swift（SceneKit / RealityKit）へ移す可能性がある。
**「何を描くか」を決める処理を、描画エンジンから切り離す。**

```
packages/gis/          OSM/PLATEAU の解釈、寸法の決定    … Cesium を import しない
packages/shared/       型と「形の記述」(scene.ts)        … Cesium を import しない
packages/map-engine/   形の記述を Cesium で描く          … ここだけ Cesium に依存
```

`packages/shared/src/scene.ts` の `SceneShape`（押し出し・直方体・地表の帯）が境界。
Swift の struct / enum にそのまま対応する形にしてある。
新しい描画物を足すときは、まず形の記述として書き、それから描画側を書く。

## 6. コミット

- 何を直したか、**なぜそうしたか、どう確かめたか** を本文に書く
- 末尾に必ず次の 2 行を付ける:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0141KNus4hbP42KuHinidDLC
```

- ブランチは `claude/immersive-japan-3d-nav-nqqna7`。他へは押さない
- `git add -A` の前に `git status` を見る。関係のない変更を巻き込まない
- Pull Request は頼まれたときだけ作る

## 7. 検証

```
npm run typecheck     # tsc --noEmit
npm test              # node:test（packages/*/src/__tests__/*.test.ts）
npm run build         # Next.js のビルド
```

**見た目で確かめられないものはテストで測る。**
「防音壁を立てたつもりが寝ていた」「柱が線路に対して斜めを向いていた」は
スクリーンショットでは気づけなかった。生成した頂点の座標を実際に測る。

テストのコメントには **出典と、その値である理由** を書く。
テストがそのまま仕様書になり、圧縮で失われない記録になる。

実測の道具（感覚で「軽くなった」と言わないために）:

```
npm run survey:road-timing   道路の組み立てにかかる時間（中央値）
npm run survey:roads         道路の形の数と頂点数
npm run survey:lod           PLATEAU の LOD 整備状況
npm run measure:startup      起動直後の取得の順序と本数（実機ブラウザ）
npm run measure:smoke        画面を開いて壊れないかの通し確認（実機ブラウザ）
```

`measure:*` は先に `npm run build && npx next start -p 3100` が要る。

## 8. 圧縮で記憶が飛んだときの復元手順

会話が圧縮されると、途中のやり取りは失われる。
**失われても困らないように、判断の根拠はすべてファイルに落としてある。**

思い出せなくなったら、この順に読む。

1. **この CLAUDE.md** … 曲げてはいけない方針
2. **`docs/requests.md`** … これまでに何を頼まれ、どう応えたか（依頼の全台帳）
3. **`docs/worklog.md`** … いまどこまで進み、何が残っているか
4. **`docs/pitfalls.md`** … 同じ穴に二度落ちないための記録
5. **`git log`** … コミット本文に「なぜそうしたか・どう確かめたか」を書いてある

それでも足りなければ、セッションの記録そのものが
`/root/.claude/projects/-home-user-map-3D/<セッション ID>.jsonl` にある。
`type === 'user'` の行だけを拾えば、受けた指示を時系列で復元できる
（2026-09-04 に実際にそうして `docs/requests.md` を作った）。

**新しい依頼を受けたら、着手する前に `docs/requests.md` へ 1 行足す。**
恒久的な方針ならこの CLAUDE.md にも写す。
片方だけだと、圧縮のあとに必ず落ちる。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
