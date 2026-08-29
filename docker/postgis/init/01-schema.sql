-- 道路ネットワーク / POI / 建物属性の永続化スキーマ。
--
-- 設計方針:
--  * 座標は WGS84 (EPSG:4326) で保持し、必要に応じて ST_Transform で
--    平面直角座標系 (JGD2011, EPSG:6669..6687) に変換する。
--  * 道路は「線」ではなく、ノード（交差点・横断歩道・信号）と
--    エッジ（車道・歩道・横断歩道・自転車道）に分解して保持する。

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------- 道路ノード
CREATE TABLE IF NOT EXISTS road_nodes (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (
                   kind IN ('intersection','crossing','traffic_signal','stop','entrance','endpoint')
                 ),
    degree       SMALLINT NOT NULL DEFAULT 1,
    has_signal   BOOLEAN  NOT NULL DEFAULT FALSE,
    has_crossing BOOLEAN  NOT NULL DEFAULT FALSE,
    tags         JSONB,
    geom         GEOMETRY(Point, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS road_nodes_geom_idx ON road_nodes USING GIST (geom);
CREATE INDEX IF NOT EXISTS road_nodes_kind_idx ON road_nodes (kind);

-- ---------------------------------------------------------------- 道路エッジ
CREATE TABLE IF NOT EXISTS road_edges (
    id            TEXT PRIMARY KEY,
    kind          TEXT NOT NULL CHECK (
                    kind IN ('road','sidewalk','crosswalk','cycleway','footway','stairs','service')
                  ),
    name          TEXT,
    highway       TEXT NOT NULL,
    oneway        BOOLEAN NOT NULL DEFAULT FALSE,
    lanes         SMALLINT,
    length_m      DOUBLE PRECISION NOT NULL,
    start_node_id TEXT REFERENCES road_nodes(id) ON DELETE CASCADE,
    end_node_id   TEXT REFERENCES road_nodes(id) ON DELETE CASCADE,
    tags          JSONB,
    geom          GEOMETRY(LineString, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS road_edges_geom_idx ON road_edges USING GIST (geom);
CREATE INDEX IF NOT EXISTS road_edges_kind_idx ON road_edges (kind);
CREATE INDEX IF NOT EXISTS road_edges_name_idx ON road_edges (name);

-- ---------------------------------------------------------------- POI
CREATE TABLE IF NOT EXISTS pois (
    id       TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    category TEXT NOT NULL,
    tags     JSONB,
    geom     GEOMETRY(Point, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS pois_geom_idx ON pois USING GIST (geom);
CREATE INDEX IF NOT EXISTS pois_category_idx ON pois (category);
CREATE INDEX IF NOT EXISTS pois_name_trgm_idx ON pois (name);

-- ---------------------------------------------------------------- 建物属性
-- 形状そのものは 3D Tiles 側が持つ。ここでは検索・情報表示用の属性のみ。
CREATE TABLE IF NOT EXISTS buildings (
    id            TEXT PRIMARY KEY,
    gml_id        TEXT,
    name          TEXT,
    building_type TEXT,
    height_m      DOUBLE PRECISION,
    levels        SMALLINT,
    address       TEXT,
    city_code     TEXT,
    sources       TEXT[] NOT NULL DEFAULT '{}',
    tags          JSONB,
    geom          GEOMETRY(Point, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS buildings_geom_idx ON buildings USING GIST (geom);
CREATE INDEX IF NOT EXISTS buildings_gml_idx ON buildings (gml_id);

-- ------------------------------------------------------- データ取り込み履歴
-- パイプラインの再現性のため、何をいつ取り込んだかを記録する。
CREATE TABLE IF NOT EXISTS import_runs (
    id          BIGSERIAL PRIMARY KEY,
    source      TEXT NOT NULL,
    source_url  TEXT,
    input_hash  TEXT,
    bbox        GEOMETRY(Polygon, 4326),
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    stats       JSONB
);

-- ------------------------------------------------------------------ 便利関数
-- 指定地点の近傍 POI（メートル指定）
CREATE OR REPLACE FUNCTION pois_near(lat DOUBLE PRECISION, lng DOUBLE PRECISION, radius_m DOUBLE PRECISION)
RETURNS TABLE (id TEXT, name TEXT, category TEXT, distance_m DOUBLE PRECISION)
LANGUAGE sql STABLE AS $$
    SELECT p.id,
           p.name,
           p.category,
           ST_Distance(p.geom::geography, ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) AS distance_m
    FROM pois p
    WHERE ST_DWithin(p.geom::geography, ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography, radius_m)
    ORDER BY distance_m
$$;

-- 交差点の複雑さ（カメラ演出の判断材料）
CREATE OR REPLACE FUNCTION intersection_complexity(lat DOUBLE PRECISION, lng DOUBLE PRECISION, radius_m DOUBLE PRECISION DEFAULT 35)
RETURNS DOUBLE PRECISION
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(MAX(n.degree), 0)
         + 1.5 * COUNT(*) FILTER (WHERE n.has_signal)
         + 0.5 * COUNT(*) FILTER (WHERE n.has_crossing)
    FROM road_nodes n
    WHERE ST_DWithin(n.geom::geography, ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography, radius_m)
$$;
