# Vercel へのデプロイ

## 結論

**インポートして Deploy を押すだけです。Root Directory は既定（リポジトリ直下 `/`）のまま変更しないでください。**

Next.js アプリはリポジトリ直下にあり、`package.json` に `next` が入っているので、
Vercel の自動検出がそのまま通ります。

---

## 「Next.jsのバージョンが検出されませんでした」への対処

> Next.jsのバージョンが検出されませんでした。package.json ファイルの「dependencies」または
> 「devDependencies」に「next」が含まれていることを確認してください。また、ルートディレクトリの
> 設定が package.json ファイルのあるディレクトリと一致していることを確認してください。

Vercel は **Root Directory にある `package.json`** を見て Next.js を検出します。
このエラーは「Root Directory に指定した場所に `next` を持つ `package.json` が無い」という意味です。

本リポジトリは以前アプリを `apps/web/` に置いていたため、Root Directory を `/` のままにすると
このエラーになりました。**現在はアプリをリポジトリ直下に移してあるので、Root Directory は `/`（既定）が正解です。**

### なぜサブディレクトリ構成をやめたか（公式仕様の裏付け）

Vercel の公式ドキュメントには、Root Directory についてこう書かれています。

> Your app will not be able to access files outside of that directory.
> You also cannot use `..` to move up a level.
> （そのディレクトリ外のファイルにはアクセスできない。`..` で上の階層へ移動することもできない）
> — [Configuring a Build / Root Directory](https://vercel.com/docs/builds/configure-a-build#root-directory)

つまり Root Directory を `apps/web` にすると、**`packages/*` や `scripts/` を参照できず、
`cd ../.. && npm install` のような回避策も仕様上できません**。
npm workspaces のモノレポでは、この制約のせいで install 自体が成立しなくなります。

そのため本リポジトリは **Next.js アプリをリポジトリ直下に置き、Root Directory を使わない**構成にしています。

### 既存プロジェクトを直す手順

Project → **Settings → Build and Deployment → Root Directory** を確認してください。

| 現在の値 | 対処 |
| --- | --- |
| `apps/web`（以前の案内で設定した場合） | **空欄に戻す**（＝リポジトリ直下）。保存して Redeploy |
| 空欄 / `.` / `/` | そのままで OK。最新コミットで Redeploy |

Redeploy は **Deployments → 右上の … → Redeploy** から。ビルドキャッシュが残っていて挙動が変な場合は
「Use existing Build Cache」のチェックを外してください。

---

## 手順（新規インポート）

1. Vercel で **Add New → Project** から本リポジトリをインポート
2. Framework Preset が **Next.js** になっていることを確認（自動で入ります）
3. **Root Directory は触らない**
4. 環境変数は任意（後述）。設定しなくても地図・経路・検索は動きます
5. **Deploy**

### Vercel CLI の場合

```bash
npm i -g vercel
cd map-3d          # リポジトリ直下
vercel link
vercel --prod
```

---

## リポジトリ側の構成

```
map-3d/
├── package.json        ← next（固定バージョン）を含む（Vercel はこれを見る）
├── next.config.ts
├── vercel.json
├── app/                ← App Router（画面 + API Route Handlers）
├── components/
├── lib/
├── public/             ← prebuild で public/cesium が生成される
├── packages/           ← 共有ロジック（file: 依存で参照）
└── apps/api/           ← セルフホスト用 API（Vercel では使わない）
```

`vercel.json`:

```jsonc
{
  "framework": "nextjs",
  "installCommand": "npm install",   // packages/* は file: 依存として同時に解決される
  "buildCommand": "npm run build",   // prebuild → Cesium アセットのコピー → next build
  "regions": ["hnd1"],               // 東京リージョン
  "functions": {
    "app/api/ai/chat/route.ts": { "maxDuration": 60 },
    "app/api/route/route.ts": { "maxDuration": 30 },
    "app/api/poi/route.ts": { "maxDuration": 45 },
    "app/api/furniture/route.ts": { "maxDuration": 45 }
  },
  "headers": [ /* /cesium/* を immutable キャッシュ */ ]
}
```

ポイント:

- **`buildCommand` は `next build` ではなく `npm run build`。**
  `prebuild` フックで CesiumJS の静的アセット（Workers / Assets / Widgets / ThirdParty）が
  `public/cesium` にコピーされます。これが無いと 3D が真っ黒になります。
- `packages/*` は `next.config.ts` の `transpilePackages` で TypeScript のまま取り込まれるため、
  事前ビルドは不要です。
- `maxDuration` はプランごとに上限があります。超えるとデプロイが弾かれるので、その場合は値を下げてください。

### Node.js のバージョン

`package.json` の `engines.node` と `.nvmrc` で **Node 22 以上**を指定しています。

Vercel は 2026 年 10 月 1 日に **Node.js 20 を非推奨**にする予定のため
（[Supported Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)）、
20 系が選ばれないようにしてあります。ダッシュボードの
**Settings → Build and Deployment → Node.js Version** が 20.x のままなら 22.x 以上へ変更してください。

### maxDuration の上限

Fluid compute 有効時の上限は Hobby で 300 秒、Pro / Enterprise で 800 秒です
（[Vercel Functions Limits](https://vercel.com/docs/functions/limitations)）。
本リポジトリの設定は最大 60 秒なので、**どのプランでもそのまま通ります**。

---

## 環境変数

**何も設定しなくてもデプロイできます。** 地図・地形・建物・経路探索・地名検索は公開データと
公開 API を使うため、API キーは不要です。

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `AI_PROVIDER` | AI 機能を使う場合のみ | `openai` / `anthropic` / `gemini` / `local` |
| `AI_MODEL` | 任意 | 例 `gpt-4o-mini` |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | プロバイダに応じて | LLM の API キー |
| `VALHALLA_URL` | 任意 | 自前 Valhalla。未設定なら FOSSGIS の公開デモ（1 req/秒） |
| `OVERPASS_ENDPOINTS` | 任意 | 自前 Overpass。カンマ区切りで複数指定可 |
| `NOMINATIM_URL` | 任意 | 自前 Nominatim |
| `OSM_USER_AGENT` | 推奨 | 公開インスタンス利用時の識別子（連絡先を含める） |

`NEXT_PUBLIC_` を付けた変数だけがブラウザに露出します。**API キーには絶対に付けないでください。**
（本アプリの API キーはすべてサーバ側の Route Handler の中だけで使われます。）

---

## デプロイ後の確認

```bash
curl -s https://<あなたのドメイン>/api/config | head -c 200
curl -s "https://<あなたのドメイン>/api/route?from=35.681236,139.767125&to=35.685175,139.752799&mode=walk" | head -c 200
curl -s -o /dev/null -w "%{http_code}\n" https://<あなたのドメイン>/cesium/Widgets/widgets.css
```

- `/api/config` … 都市一覧・タイル URL・出典が返る
- `/api/route` … 経路（距離・所要時間・日本語の案内）が返る
- `/cesium/Widgets/widgets.css` … 200 が返る（404 なら Cesium アセットのコピーが走っていない）
- ブラウザで開くと東京都心の 3D 都市が表示される

---

## うまくいかないときは

| 症状 | 原因と対処 |
| --- | --- |
| `No Next.js version detected` / 「Next.jsのバージョンが検出されませんでした」 | Root Directory が `apps/web` などになっている。**空欄（リポジトリ直下）に戻す** |
| `Module not found: Can't resolve '@ijm/shared'` | install がリポジトリ直下で走っていない。Install Command の上書きを外す |
| 3D が真っ黒／`/cesium/...` が 404 | Build Command を `next build` に上書きしている。`npm run build` に戻す（prebuild が必要） |
| 建物・地図タイルだけ出ない | PLATEAU 配信サービス側の一時的な障害。`npm run validate:cities` で疎通確認できる |
| 経路探索が 502／遅い | 公開 Valhalla のレート制限（1 req/秒）。本番は自前 Valhalla（`VALHALLA_URL`）へ |
| POI が空で「取得できませんでした」 | 公開 Overpass の混雑。`OVERPASS_ENDPOINTS` で別インスタンスを指定 |
| AI パネルが「未設定」 | `AI_PROVIDER` と API キーが未設定。設定後に再デプロイ |
| 関数が `maxDuration` でデプロイ拒否 | プランの上限超過。`vercel.json` の値を下げる |

## 補足: なぜアプリをリポジトリ直下に置いているか

当初は要件どおり `apps/web/` に置いていましたが、Vercel のフレームワーク検出が
Root Directory の `package.json` に依存するため、設定を 1 つ間違えるとデプロイできませんでした。

デプロイの確実性を優先し、**Next.js アプリを直下、共有ロジックを `packages/*`** という
（Next.js のモノレポとして一般的な）構成に変更しています。
`apps/api`（セルフホスト用 API）と `packages/*` の分割はそのままなので、
「3D エンジン・ナビゲーション・GIS・AI がアプリから独立している」という設計は変わりません。
