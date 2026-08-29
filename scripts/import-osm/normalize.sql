-- osm2pgsql が作った planet_osm_* テーブルから、
-- 本アプリのスキーマ（road_nodes / road_edges / pois）へ正規化する。
--
-- osm2pgsql の既定は EPSG:3857 なので、4326 に戻してから格納する。

BEGIN;

-- ---------------------------------------------------------------- 道路エッジ
INSERT INTO road_edges (id, kind, name, highway, oneway, lanes, length_m, start_node_id, end_node_id, tags, geom)
SELECT
    'w' || osm_id                                            AS id,
    CASE
        WHEN highway = 'steps'                              THEN 'stairs'
        WHEN highway = 'cycleway'                           THEN 'cycleway'
        WHEN highway = 'footway' AND tags->'footway' = 'crossing' THEN 'crosswalk'
        WHEN highway = 'footway' AND tags->'footway' = 'sidewalk' THEN 'sidewalk'
        WHEN highway IN ('footway','path','pedestrian','corridor') THEN 'footway'
        WHEN highway IN ('service','track')                 THEN 'service'
        ELSE 'road'
    END                                                      AS kind,
    COALESCE(tags->'name:ja', name)                          AS name,
    highway,
    COALESCE(oneway IN ('yes','1','-1'), FALSE)              AS oneway,
    NULLIF(tags->'lanes','')::SMALLINT                       AS lanes,
    ST_Length(ST_Transform(way, 4326)::geography)            AS length_m,
    NULL, NULL,
    hstore_to_jsonb(tags)                                    AS tags,
    ST_Transform(ST_LineMerge(way), 4326)                    AS geom
FROM planet_osm_line
WHERE highway IS NOT NULL
  AND GeometryType(ST_Transform(ST_LineMerge(way), 4326)) = 'LINESTRING'
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------- 道路ノード
-- 信号・横断歩道・停止線などのタグ付きノード
INSERT INTO road_nodes (id, kind, degree, has_signal, has_crossing, tags, geom)
SELECT
    'n' || osm_id,
    CASE
        WHEN highway = 'traffic_signals' THEN 'traffic_signal'
        WHEN highway = 'crossing'        THEN 'crossing'
        WHEN highway = 'stop'            THEN 'stop'
        WHEN tags ? 'entrance'           THEN 'entrance'
        ELSE 'endpoint'
    END,
    1,
    highway = 'traffic_signals',
    highway = 'crossing',
    hstore_to_jsonb(tags),
    ST_Transform(way, 4326)
FROM planet_osm_point
WHERE highway IN ('traffic_signals','crossing','stop')
   OR tags ? 'entrance'
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------- POI
INSERT INTO pois (id, name, category, tags, geom)
SELECT
    'n' || osm_id,
    COALESCE(tags->'name:ja', name),
    CASE
        WHEN shop = 'convenience'                     THEN 'convenience'
        WHEN amenity = 'cafe'                         THEN 'cafe'
        WHEN amenity IN ('restaurant','fast_food')    THEN 'restaurant'
        WHEN amenity IN ('hospital','clinic')         THEN 'hospital'
        WHEN amenity IN ('school','university')       THEN 'school'
        WHEN leisure IN ('park','garden')             THEN 'park'
        WHEN railway = 'station'                      THEN 'station'
        WHEN amenity = 'parking'                      THEN 'parking'
        WHEN amenity = 'toilets'                      THEN 'toilets'
        WHEN amenity IN ('atm','bank')                THEN 'atm'
        WHEN tourism IN ('hotel','hostel')            THEN 'hotel'
        WHEN shop IS NOT NULL                         THEN 'shop'
        ELSE 'other'
    END,
    hstore_to_jsonb(tags),
    ST_Transform(way, 4326)
FROM planet_osm_point
WHERE COALESCE(tags->'name:ja', name) IS NOT NULL
  AND (shop IS NOT NULL OR amenity IS NOT NULL OR leisure IS NOT NULL
       OR railway = 'station' OR tourism IS NOT NULL)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

-- 交差点の次数を、エッジ端点の共有数から再計算する
UPDATE road_nodes n
SET degree = sub.cnt,
    kind = CASE WHEN sub.cnt >= 3 AND n.kind = 'endpoint' THEN 'intersection' ELSE n.kind END
FROM (
    SELECT n.id, COUNT(e.id) AS cnt
    FROM road_nodes n
    JOIN road_edges e ON ST_DWithin(n.geom, e.geom, 0.00001)
    GROUP BY n.id
) sub
WHERE n.id = sub.id;

INSERT INTO import_runs (source, source_url, finished_at, stats)
VALUES (
    'osm2pgsql normalize',
    NULL,
    now(),
    jsonb_build_object(
        'road_edges', (SELECT COUNT(*) FROM road_edges),
        'road_nodes', (SELECT COUNT(*) FROM road_nodes),
        'pois',       (SELECT COUNT(*) FROM pois)
    )
);

COMMIT;
