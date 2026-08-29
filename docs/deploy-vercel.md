# Vercel へのデプロイ

## 結論（これだけ守れば動く）

**Vercel のプロジェクト設定で Root Directory を `apps/web` にする。** 他の設定は不要です。

---

## なぜ「No Next.js version detected」が出るのか

Vercel は **Root Directory にある `package.json`** を見て、そこに `next` があるかどうかで
Next.js プロジェクトだと判定します。

本リポジトリはモノレポで、`next` は `apps/web/package.json` にしかありません。

```
map-3d/
├── package.json          ← Root Directory を「/」にすると Vercel はこれを見る（next が無い）
└── apps/
    └── web/
        └── package.json  ← next はここにある
```

そのため Root Directory を既定の `/`（リポジトリ直下）のままインポートすると、

> No Next.js version detected. Make sure your package.json has "next" in either "dependencies" or "devDependencies".

というエラーになります。**Root Directory を `apps/web` にすれば解決します。**

`outputDirectory` で `apps/web/.next` を指す方法は Next.js プリセットでは当てにできないため、
そのやり方は採用していません（リポジトリ直下の `vercel.json` は削除済みです）。

---

## 手順（ダッシュボード）

1. Vercel で **Add New → Project** から本リポジトリをインポート
2. **Root Directory** の `Edit` を押し、`apps/web` を選択
   - 「Include source files outside of the Root Directory in the Build Step」は **ON のまま**にする
     （`packages/*` と `scripts/` を参照するため）
3. Framework Preset が **Next.js** になっていることを確認（自動で入ります）
4. Build / Install コマンドは触らない（`apps/web/vercel.json` の設定が使われます）
5. 環境変数は任意（後述）。設定しなくても地図・経路・検索は動きます
6. **Deploy**

### 既にインポート済みのプロジェクトを直す場合

Project → **Settings → Build and Deployment → Root Directory** を `apps/web` に変更して、
**Redeploy**（キャッシュを使わない再デプロイ）を実行してください。

## 手順（Vercel CLI）

```bash
npm i -g vercel
cd apps/web        # ここが Root Directory になる
vercel link
vercel --prod
```

---

## リポジトリ側の設定（`apps/web/vercel.json`）

```jsonc
{
  "framework": "nextjs",
  "installCommand": "cd ../.. && npm install",              // ワークスペース全体を root で install
  "buildCommand": "cd ../.. && npm run build --workspace @ijm/web",
  "regions": ["hnd1"],                                       // 東京リージョン
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

- **`installCommand` はリポジトリのルートで `npm install` する。**
  `@ijm/shared` などのワークスペース依存は、ルートで install しないと解決できません
  （`apps/web` の中だけで install すると npm がレジストリに `@ijm/shared` を探しに行って失敗します）。
- **`buildCommand` もルートから `--workspace` 付きで実行する。**
  `prebuild` が走り、CesiumJS の静的アセット（Workers / Assets / Widgets / ThirdParty）が
  `apps/web/public/cesium` にコピーされます。これが無いと 3D が真っ黒になります。
- `functions` のパスは **Root Directory からの相対パス**です（`apps/web/` を付けない）。
- `maxDuration` はプランごとに上限があります。上限を超えるとデプロイが弾かれるので、
  その場合は値を下げてください。

`apps/web/next.config.ts` 側では次の 2 つがモノレポ対応に効いています。

- `transpilePackages`: `packages/*` の TypeScript ソースをそのままビルドに取り込む
  （各パッケージを事前ビルドしなくてよい）
- `outputFileTracingRoot`: サーバ関数のファイルトレースの基点をリポジトリのルートに固定
  （`apps/web` の外にある `packages/*` を取りこぼさない）

---

## 環境変数

**何も設定しなくてもデプロイできます。** 地図・地形・建物・経路探索・地名検索は公開データと
公開 API を使うため、API キーは不要です。

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `AI_PROVIDER` | AI 機能を使う場合のみ | `openai` / `anthropic` / `gemini` / `local` |
| `AI_MODEL` | 任意 | 例 `gpt-4o-mini` |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | プロバイダに応じて | LLM の API キー |
| `VALHALLA_URL` | 任意 | 自前 Valhalla を使う場合。未設定なら FOSSGIS の公開デモ |
| `OVERPASS_ENDPOINTS` | 任意 | 自前 Overpass。カンマ区切りで複数指定可 |
| `NOMINATIM_URL` | 任意 | 自前 Nominatim |
| `OSM_USER_AGENT` | 推奨 | 公開インスタンス利用時の識別子（連絡先を含める） |

`NEXT_PUBLIC_` を付けた変数だけがブラウザに露出します。**API キーには絶対に付けないでください。**
（本アプリの API キーはすべてサーバ側の Route Handler の中だけで使われます。）

---

## デプロイ後の確認

```bash
curl -s https://<あなたのドメイン>/api/config | head -c 200
curl -s "https://<あなたのドメイン>/api/route?from=35.681236,139.767125&to=35.685175,139.752799&mode=walk" \
  | head -c 200
```

- `/api/config` … 都市一覧・タイル URL・出典が返る
- `/api/route` … 経路（距離・所要時間・日本語の案内）が返る
- ブラウザで開くと東京都心の 3D 都市が表示される

---

## うまくいかないときは

| 症状 | 原因と対処 |
| --- | --- |
| `No Next.js version detected` | Root Directory が `apps/web` になっていない |
| `Module not found: Can't resolve '@ijm/shared'` | install がワークスペースのルートで走っていない。`apps/web/vercel.json` の `installCommand` が効いているか確認 |
| `Cannot find module '../../scripts/copy-cesium-assets.mjs'` | 「Include source files outside of the Root Directory」が OFF。ON に戻す |
| 3D が真っ黒／`/cesium/Workers/...` が 404 | `prebuild` が走っていない。Build Command を上書きしていないか確認 |
| 建物・地図タイルだけ出ない | PLATEAU 配信サービス側の一時的な障害。`npm run validate:cities` で疎通確認できる |
| 経路探索が 502／遅い | 公開 Valhalla のレート制限（1 req/秒）。本番は自前 Valhalla（`VALHALLA_URL`）へ |
| POI が空で「取得できませんでした」 | 公開 Overpass の混雑。`OVERPASS_ENDPOINTS` で別インスタンスを指定 |
| AI パネルが「未設定」 | `AI_PROVIDER` と API キーが未設定。設定後に再デプロイ |
| 関数が `maxDuration` でデプロイ拒否 | プランの上限を超えている。`apps/web/vercel.json` の値を下げる |

## 補足: Root Directory を変えられない場合

組織のポリシーなどで Root Directory を変更できない場合は、次のいずれかになります。

1. `apps/web` を別リポジトリに切り出し、`packages/*` を npm パッケージとして公開する
2. Vercel 以外（Docker / Node ホスティング）に置く。`docker/docker-compose.yml` がそのまま使えます

リポジトリ直下を Root Directory にしたまま Next.js としてデプロイする方法は、
`outputDirectory` が Next.js プリセットで意図通りに扱われる保証がないため推奨しません。
