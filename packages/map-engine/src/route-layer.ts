/**
 * ルート・マーカー・交差点ハイライトの描画。
 *
 * ルートは「地面にクランプした発光ライン + 進行方向の矢印」で表現する。
 * 単なるポリラインより道路面に沿って見え、3D 都市の中でも視認できる。
 */

import * as Cesium from 'cesium';
import type { IconName, LatLng, Poi, Route } from '@ijm/shared';
import { markerUri, type MarkerKind } from './marker-icons';
import { liveScene } from './primitive-swap';

export interface MarkerOptions {
  id: string;
  position: LatLng;
  label?: string;
  /** 地面からの高さ (m) */
  height?: number;
  kind?: 'origin' | 'destination' | 'poi' | 'highlight';
  /** マーカー内に描くアイコン（未指定なら kind から決まる） */
  iconName?: IconName;
}

const MODE_COLORS: Record<string, Cesium.Color> = {
  walk: Cesium.Color.fromCssColorString('#38d9c8'),
  drive: Cesium.Color.fromCssColorString('#4da3ff'),
  bicycle: Cesium.Color.fromCssColorString('#8ce36b'),
  transit: Cesium.Color.fromCssColorString('#ffab4d'),
  multimodal: Cesium.Color.fromCssColorString('#c58cff'),
};

export class RouteLayer {
  private readonly routeSource = new Cesium.CustomDataSource('ijm-route');
  private readonly markerSource = new Cesium.CustomDataSource('ijm-markers');
  private readonly highlightSource = new Cesium.CustomDataSource('ijm-highlight');
  private ready: Promise<void>;
  private currentRoute: Route | null = null;
  private positionEntity: Cesium.Entity | null = null;
  private intersectionEntity: Cesium.Entity | null = null;

  constructor(private readonly viewer: Cesium.Viewer) {
    this.ready = Promise.all([
      viewer.dataSources.add(this.routeSource),
      viewer.dataSources.add(this.markerSource),
      viewer.dataSources.add(this.highlightSource),
    ]).then(() => undefined);
  }

  async whenReady(): Promise<void> {
    await this.ready;
  }

  get route(): Route | null {
    return this.currentRoute;
  }

  /** ルートを描画する */
  async showRoute(route: Route): Promise<void> {
    await this.whenReady();
    // データソースの用意を待っている間に画面を離れているかもしれない
    if (!liveScene(this.viewer)) return;
    this.routeSource.entities.removeAll();
    this.currentRoute = route;

    const positions = route.coordinates.map(([lng, lat]) => Cesium.Cartesian3.fromDegrees(lng, lat));
    const color = MODE_COLORS[route.mode] ?? MODE_COLORS.walk;

    // 下地（太く暗いライン）で道路面とのコントラストを確保
    this.routeSource.entities.add({
      id: `${route.id}-base`,
      polyline: {
        positions,
        width: 22,
        clampToGround: true,
        material: new Cesium.ColorMaterialProperty(
          Cesium.Color.fromCssColorString('#0b1622').withAlpha(0.55),
        ),
        zIndex: 10,
      },
    });

    // 本体（発光ライン）
    this.routeSource.entities.add({
      id: route.id,
      polyline: {
        positions,
        width: 14,
        clampToGround: true,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.25,
          taperPower: 1.0,
          color,
        }),
        zIndex: 11,
      },
    });

    // 進行方向の矢印
    this.routeSource.entities.add({
      id: `${route.id}-arrows`,
      polyline: {
        positions,
        width: 7,
        clampToGround: true,
        material: new Cesium.PolylineArrowMaterialProperty(Cesium.Color.WHITE.withAlpha(0.75)),
        zIndex: 12,
      },
    });

    // 出発・到着マーカー
    const first = route.coordinates[0];
    const last = route.coordinates[route.coordinates.length - 1];
    if (first && last) {
      this.setMarker({
        id: 'route-origin',
        position: { lng: first[0], lat: first[1] },
        label: '出発',
        kind: 'origin',
      });
      this.setMarker({
        id: 'route-destination',
        position: { lng: last[0], lat: last[1] },
        label: '目的地',
        kind: 'destination',
      });
    }

    // マニューバ地点（曲がる交差点）に小さな印を置く
    for (const [i, m] of route.maneuvers.entries()) {
      if (m.type === 'continue' || m.type === 'start' || m.type === 'destination') continue;
      this.routeSource.entities.add({
        id: `${route.id}-m${i}`,
        position: Cesium.Cartesian3.fromDegrees(m.location.lng, m.location.lat),
        point: {
          pixelSize: 9,
          color: Cesium.Color.WHITE,
          outlineColor: color,
          outlineWidth: 3,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: 200,
        },
      });
    }
  }

  clearRoute(): void {
    this.routeSource.entities.removeAll();
    this.currentRoute = null;
  }

  /** 現在地マーカー（ナビ中の自分の位置） */
  updatePosition(position: LatLng, heading: number): void {
    const cartesian = Cesium.Cartesian3.fromDegrees(position.lng, position.lat);
    if (!this.positionEntity) {
      this.positionEntity = this.markerSource.entities.add({
        id: 'current-position',
        position: cartesian,
        ellipse: {
          semiMajorAxis: 6,
          semiMinorAxis: 6,
          material: Cesium.Color.fromCssColorString('#ffffff').withAlpha(0.9),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#2aa8ff'),
          outlineWidth: 3,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          zIndex: 30,
        },
        // 進行方向を示すコーン
        cylinder: {
          length: 6,
          topRadius: 0,
          bottomRadius: 3.2,
          material: Cesium.Color.fromCssColorString('#2aa8ff').withAlpha(0.95),
          heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
        },
      });
    } else {
      this.positionEntity.position = new Cesium.ConstantPositionProperty(cartesian);
    }

    // コーンを進行方向に倒す
    const hpr = new Cesium.HeadingPitchRoll(
      Cesium.Math.toRadians(heading),
      Cesium.Math.toRadians(90),
      0,
    );
    this.positionEntity.orientation = new Cesium.ConstantProperty(
      Cesium.Transforms.headingPitchRollQuaternion(cartesian, hpr),
    );
  }

  hidePosition(): void {
    if (this.positionEntity) {
      this.markerSource.entities.remove(this.positionEntity);
      this.positionEntity = null;
    }
  }

  /** 交差点ハイライト（近づいた交差点を光らせる） */
  highlightIntersection(location: LatLng | null, radius = 22): void {
    if (!location) {
      if (this.intersectionEntity) {
        this.highlightSource.entities.remove(this.intersectionEntity);
        this.intersectionEntity = null;
      }
      return;
    }

    const position = Cesium.Cartesian3.fromDegrees(location.lng, location.lat);
    if (!this.intersectionEntity) {
      this.intersectionEntity = this.highlightSource.entities.add({
        id: 'intersection-highlight',
        position,
        ellipse: {
          semiMajorAxis: radius,
          semiMinorAxis: radius,
          material: new Cesium.ColorMaterialProperty(
            new Cesium.CallbackProperty(() => {
              // ゆっくり明滅させて注意を引く
              const t = (Date.now() % 1600) / 1600;
              const alpha = 0.22 + 0.18 * Math.sin(t * Math.PI * 2);
              return Cesium.Color.fromCssColorString('#ffd166').withAlpha(alpha);
            }, false),
          ),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#ffd166').withAlpha(0.9),
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          zIndex: 20,
        },
      });
    } else {
      this.intersectionEntity.position = new Cesium.ConstantPositionProperty(position);
      if (this.intersectionEntity.ellipse) {
        this.intersectionEntity.ellipse.semiMajorAxis = new Cesium.ConstantProperty(radius);
        this.intersectionEntity.ellipse.semiMinorAxis = new Cesium.ConstantProperty(radius);
      }
    }
  }

  /**
   * 地点マーカー。
   * 絵文字ラベルではなく、SVG から生成したピン画像をビルボードとして描画する
   * （環境による字形差が出ず、高 DPI でも滲まない）。
   */
  setMarker(options: MarkerOptions): Cesium.Entity {
    const existing = this.markerSource.entities.getById(options.id);
    if (existing) this.markerSource.entities.remove(existing);

    const kind: MarkerKind =
      options.kind === 'origin'
        ? 'origin'
        : options.kind === 'destination'
          ? 'destination'
          : 'highlight';

    const iconName: IconName =
      options.iconName ??
      (options.kind === 'origin'
        ? 'origin'
        : options.kind === 'destination'
          ? 'destination'
          : 'pin');

    return this.markerSource.entities.add({
      id: options.id,
      position: Cesium.Cartesian3.fromDegrees(
        options.position.lng,
        options.position.lat,
        options.height ?? 0,
      ),
      billboard: {
        image: markerUri(iconName, kind, 'pin'),
        width: 34,
        height: 45,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(200, 1.0, 6000, 0.6),
      },
      label: options.label
        ? {
            text: options.label,
            font: '500 13px system-ui, -apple-system, sans-serif',
            fillColor: Cesium.Color.WHITE,
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString('#0b1622').withAlpha(0.78),
            backgroundPadding: new Cesium.Cartesian2(8, 5),
            pixelOffset: new Cesium.Cartesian2(0, -50),
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(200, 1.0, 4000, 0.55),
          }
        : undefined,
    });
  }

  removeMarker(id: string): void {
    const entity = this.markerSource.entities.getById(id);
    if (entity) this.markerSource.entities.remove(entity);
  }

  /** POI マーカー。カテゴリごとの SVG バッジ + 名称ラベル。 */
  showPois(pois: Poi[], iconOf: (poi: Poi) => IconName): void {
    this.clearPois();
    for (const poi of pois) {
      this.markerSource.entities.add({
        id: `poi:${poi.id}`,
        position: Cesium.Cartesian3.fromDegrees(poi.lng, poi.lat),
        billboard: {
          image: markerUri(iconOf(poi), 'poi', 'badge'),
          width: 26,
          height: 26,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(150, 1.0, 3000, 0.5),
          translucencyByDistance: new Cesium.NearFarScalar(1500, 1.0, 4500, 0.0),
        },
        label: {
          text: poi.name,
          font: '500 12px system-ui, -apple-system, sans-serif',
          fillColor: Cesium.Color.WHITE,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('#12263a').withAlpha(0.82),
          backgroundPadding: new Cesium.Cartesian2(7, 4),
          pixelOffset: new Cesium.Cartesian2(0, -20),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(150, 1.0, 2500, 0.5),
          translucencyByDistance: new Cesium.NearFarScalar(1500, 1.0, 4000, 0.0),
        },
      });
    }
  }

  clearPois(): void {
    const toRemove = this.markerSource.entities.values.filter((e) => e.id.startsWith('poi:'));
    for (const e of toRemove) this.markerSource.entities.remove(e);
  }

  clearAll(): void {
    this.routeSource.entities.removeAll();
    this.markerSource.entities.removeAll();
    this.highlightSource.entities.removeAll();
    this.currentRoute = null;
    this.positionEntity = null;
    this.intersectionEntity = null;
  }
}
