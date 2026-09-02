# Immersive Japan Navigation — 作業の前提

このファイルはセッションをまたいで必ず読み込まれる。
会話が長くなって圧縮されても、ここに書いてあることは失われない。
**新しい制約や方針を受け取ったら、まずここに追記すること。**

関連文書:
- `docs/pitfalls.md` … 一度はまって時間を使った落とし穴。着手前に該当箇所を読む
- `docs/worklog.md` … いまどこまで進んでいて、次に何が残っているか
- `docs/architecture.md` … 全体構成

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

### 秘密情報
API キーをフロントエンドのコードに置かない。すべて環境変数（`.env.example` に雛形）。
Vercel の MCP コネクタは **読み取りのみ** で使う。

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

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
