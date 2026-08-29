/**
 * 時間帯・天候・大気表現。
 *
 * 太陽位置は Cesium の時刻（JulianDate）から物理的に計算されるため、
 * 「時刻を変える」ことで日照・影・空の色が一貫して変化する。
 */

import * as Cesium from 'cesium';
import type { QualitySettings } from './quality';

export type WeatherKind = 'clear' | 'cloudy' | 'rain' | 'snow' | 'fog';

export interface EnvironmentState {
  /** 日本標準時での時刻 (0-23.99) */
  hour: number;
  /** 日付（季節による太陽高度の違いを反映） */
  date: Date;
  weather: WeatherKind;
  /** 現在時刻に追従するか */
  followRealTime: boolean;
}

const JST_OFFSET_HOURS = 9;

/** JST の指定時刻を JulianDate に変換する */
export function jstToJulianDate(date: Date, hour: number): Cesium.JulianDate {
  const utc = new Date(
    Date.UTC(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      Math.floor(hour) - JST_OFFSET_HOURS,
      Math.round((hour % 1) * 60),
      0,
    ),
  );
  return Cesium.JulianDate.fromDate(utc);
}

export const TIME_PRESETS = [
  { hour: 6, label: '06:00', description: '朝焼け' },
  { hour: 9, label: '09:00', description: '午前' },
  { hour: 12, label: '12:00', description: '正午' },
  { hour: 17, label: '17:00', description: '夕方' },
  { hour: 19, label: '19:00', description: '日没後' },
  { hour: 22, label: '22:00', description: '夜' },
] as const;

export const WEATHER_PRESETS: { kind: WeatherKind; label: string; icon: string }[] = [
  { kind: 'clear', label: '晴れ', icon: '☀️' },
  { kind: 'cloudy', label: '曇り', icon: '☁️' },
  { kind: 'rain', label: '雨', icon: '🌧️' },
  { kind: 'snow', label: '雪', icon: '🌨️' },
  { kind: 'fog', label: '霧', icon: '🌫️' },
];

const RAIN_SHADER = /* glsl */ `
uniform sampler2D colorTexture;
uniform float intensity;
in vec2 v_textureCoordinates;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  vec2 uv = v_textureCoordinates;
  vec4 color = texture(colorTexture, uv);

  // 斜めに流れる雨筋
  float t = czm_frameNumber / 40.0;
  vec2 st = uv * vec2(40.0, 12.0);
  st.x += st.y * 0.35;
  st.y += t;
  vec2 cell = floor(st);
  float r = hash(cell);
  float streak = smoothstep(0.96, 1.0, r) * smoothstep(0.0, 0.4, fract(st.y));
  color.rgb += vec3(0.55, 0.6, 0.7) * streak * intensity;

  // 全体を少し暗く青寄りに
  color.rgb = mix(color.rgb, color.rgb * vec3(0.78, 0.82, 0.92), intensity * 0.6);
  out_FragColor = color;
}
`;

const SNOW_SHADER = /* glsl */ `
uniform sampler2D colorTexture;
uniform float intensity;
in vec2 v_textureCoordinates;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  vec2 uv = v_textureCoordinates;
  vec4 color = texture(colorTexture, uv);
  float t = czm_frameNumber / 120.0;

  float acc = 0.0;
  for (int i = 0; i < 3; i++) {
    float scale = 18.0 + float(i) * 14.0;
    vec2 st = uv * scale;
    st.y += t * (1.0 + float(i) * 0.6);
    st.x += sin((st.y + float(i)) * 1.7) * 0.35;
    vec2 cell = floor(st);
    vec2 f = fract(st) - 0.5;
    float r = hash(cell + float(i) * 17.0);
    float flake = smoothstep(0.985, 1.0, r) * smoothstep(0.35, 0.0, length(f));
    acc += flake;
  }

  color.rgb += vec3(acc) * intensity;
  color.rgb = mix(color.rgb, color.rgb * vec3(0.92, 0.94, 1.0) + 0.04, intensity * 0.5);
  out_FragColor = color;
}
`;

export class EnvironmentController {
  private weatherStage: Cesium.PostProcessStage | null = null;
  private state: EnvironmentState;

  constructor(
    private readonly viewer: Cesium.Viewer,
    private readonly quality: QualitySettings,
    initial?: Partial<EnvironmentState>,
  ) {
    const now = new Date();
    this.state = {
      hour: initial?.hour ?? 12,
      date: initial?.date ?? now,
      weather: initial?.weather ?? 'clear',
      followRealTime: initial?.followRealTime ?? false,
    };
    this.applyBaseSettings();
    this.applyTime();
    this.applyWeather();
  }

  get current(): EnvironmentState {
    return { ...this.state };
  }

  private applyBaseSettings(): void {
    const scene = this.viewer.scene;
    const globe = scene.globe;

    globe.enableLighting = true;
    globe.dynamicAtmosphereLighting = true;
    globe.dynamicAtmosphereLightingFromSun = true;
    // 地形に対する深度テストを有効にしないと、地面下の線が透けて見える
    globe.depthTestAgainstTerrain = true;
    globe.maximumScreenSpaceError = this.quality.tier === 'low' ? 4 : 2;

    if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;
    scene.fog.enabled = true;
    scene.fog.density = 0.0002;
    scene.fog.screenSpaceErrorFactor = 2.0;

    // 太陽光。scene.light を SunLight にすると時刻に応じた方向光になる
    scene.light = new Cesium.SunLight();
    scene.light.intensity = 2.4;

    if (this.quality.hdr) {
      try {
        scene.highDynamicRange = true;
      } catch {
        /* 未対応環境では無視 */
      }
    }

    scene.postProcessStages.fxaa.enabled = this.quality.fxaa;

    if (this.quality.ambientOcclusion) {
      const ao = scene.postProcessStages.ambientOcclusion;
      ao.enabled = true;
      ao.uniforms.intensity = 2.6;
      ao.uniforms.bias = 0.12;
      ao.uniforms.lengthCap = 0.35;
      ao.uniforms.stepSize = 1.6;
      ao.uniforms.blurStepSize = 0.9;
    }

    if (this.quality.bloom) {
      const bloom = scene.postProcessStages.bloom;
      bloom.enabled = true;
      bloom.uniforms.glowOnly = false;
      bloom.uniforms.contrast = 128;
      bloom.uniforms.brightness = -0.3;
      bloom.uniforms.delta = 1.0;
      bloom.uniforms.sigma = 2.0;
      bloom.uniforms.stepSize = 1.0;
    }

    this.viewer.shadows = this.quality.shadows;
    if (this.quality.shadows) {
      const sm = this.viewer.shadowMap;
      sm.enabled = true;
      sm.softShadows = this.quality.softShadows;
      sm.maximumDistance = this.quality.shadowDistance;
      sm.darkness = 0.35;
      sm.size = this.quality.tier === 'low' ? 1024 : 2048;
    }
  }

  setTime(hour: number, date = this.state.date): void {
    this.state.hour = hour;
    this.state.date = date;
    this.state.followRealTime = false;
    this.applyTime();
  }

  setFollowRealTime(follow: boolean): void {
    this.state.followRealTime = follow;
    if (follow) {
      const now = new Date();
      // JST の現在時刻
      const jstNow = new Date(now.getTime() + (JST_OFFSET_HOURS * 60 + now.getTimezoneOffset()) * 60000);
      this.state.date = jstNow;
      this.state.hour = jstNow.getHours() + jstNow.getMinutes() / 60;
    }
    this.applyTime();
  }

  private applyTime(): void {
    const julian = jstToJulianDate(this.state.date, this.state.hour);
    this.viewer.clock.currentTime = julian;
    this.viewer.clock.multiplier = this.state.followRealTime ? 1 : 0;
    this.viewer.clock.shouldAnimate = this.state.followRealTime;

    // 夜間は建物の見え方が沈むため、大気と環境光を補正する
    const night = this.state.hour < 5.5 || this.state.hour > 18.5;
    const scene = this.viewer.scene;
    scene.globe.atmosphereBrightnessShift = night ? 0.15 : 0;
    scene.globe.nightFadeInDistance = 1e7;
    scene.globe.nightFadeOutDistance = 1e7;
    scene.light.intensity = night ? 1.2 : 2.4;

    if (night) {
      // 夜は環境光を上げて真っ暗にしない（実在都市の夜景としての可読性を優先）
      scene.globe.translucency.enabled = false;
      scene.globe.lambertDiffuseMultiplier = 1.4;
    } else {
      scene.globe.lambertDiffuseMultiplier = 0.9;
    }
  }

  setWeather(weather: WeatherKind): void {
    this.state.weather = weather;
    this.applyWeather();
  }

  private applyWeather(): void {
    const scene = this.viewer.scene;
    const sky = scene.skyAtmosphere;

    if (this.weatherStage) {
      scene.postProcessStages.remove(this.weatherStage);
      this.weatherStage = null;
    }

    /** 空の色味を調整する（skyAtmosphere が無い環境では何もしない） */
    const shiftSky = (saturation: number, brightness: number): void => {
      if (!sky) return;
      sky.saturationShift = saturation;
      sky.brightnessShift = brightness;
    };

    const addStage = (name: string, shader: string, intensity: number): void => {
      if (this.quality.tier === 'low') return;
      this.weatherStage = scene.postProcessStages.add(
        new Cesium.PostProcessStage({ name, fragmentShader: shader, uniforms: { intensity } }),
      ) as Cesium.PostProcessStage;
    };

    switch (this.state.weather) {
      case 'clear':
        scene.fog.density = 0.0002;
        shiftSky(0, 0);
        break;
      case 'cloudy':
        scene.fog.density = 0.0006;
        shiftSky(-0.45, -0.15);
        break;
      case 'fog':
        scene.fog.density = 0.0035;
        shiftSky(-0.6, 0.05);
        break;
      case 'rain':
        scene.fog.density = 0.0012;
        shiftSky(-0.5, -0.25);
        addStage('ijm_rain', RAIN_SHADER, 0.8);
        break;
      case 'snow':
        scene.fog.density = 0.0018;
        shiftSky(-0.35, 0.1);
        addStage('ijm_snow', SNOW_SHADER, 0.9);
        break;
    }
  }

  destroy(): void {
    if (this.weatherStage) {
      this.viewer.scene.postProcessStages.remove(this.weatherStage);
      this.weatherStage = null;
    }
  }
}
