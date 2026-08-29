/**
 * POI カテゴリと OSM タグの対応表。
 * ここを増やすだけで検索対象カテゴリを追加できる。
 */

import type { IconName, PoiCategory } from '@ijm/shared';

export interface CategoryDefinition {
  category: PoiCategory;
  /** UI 表示名 */
  label: string;
  /** Overpass のタグフィルタ（OR 結合される） */
  filters: string[];
  /** 自然言語の別名（AI からの指定を解決するため） */
  aliases: string[];
  /** @ijm/shared の ICONS に対応するアイコン名（絵文字は使わない） */
  iconName: IconName;
}

export const CATEGORY_DEFINITIONS: readonly CategoryDefinition[] = [
  {
    category: 'convenience',
    label: 'コンビニ',
    filters: ['[shop=convenience]'],
    aliases: ['コンビニ', 'コンビニエンスストア', 'convenience', 'convenience store'],
    iconName: 'store',
  },
  {
    category: 'cafe',
    label: 'カフェ',
    filters: ['[amenity=cafe]'],
    aliases: ['カフェ', '喫茶', 'コーヒー', 'cafe', 'coffee'],
    iconName: 'cafe',
  },
  {
    category: 'restaurant',
    label: '飲食店',
    filters: ['[amenity=restaurant]', '[amenity=fast_food]'],
    aliases: ['レストラン', '飲食店', 'ごはん', '食事', 'restaurant', 'food'],
    iconName: 'restaurant',
  },
  {
    category: 'hospital',
    label: '病院',
    filters: ['[amenity=hospital]', '[amenity=clinic]'],
    aliases: ['病院', 'クリニック', '医院', 'hospital', 'clinic'],
    iconName: 'hospital',
  },
  {
    category: 'school',
    label: '学校',
    filters: ['[amenity=school]', '[amenity=university]', '[amenity=kindergarten]'],
    aliases: ['学校', '大学', '幼稚園', 'school', 'university'],
    iconName: 'school',
  },
  {
    category: 'park',
    label: '公園',
    filters: ['[leisure=park]', '[leisure=garden]'],
    aliases: ['公園', '庭園', 'park', 'garden'],
    iconName: 'park',
  },
  {
    category: 'station',
    label: '駅',
    filters: ['[railway=station]', '[public_transport=station]'],
    aliases: ['駅', '鉄道駅', 'station'],
    iconName: 'transit',
  },
  {
    category: 'parking',
    label: '駐車場',
    filters: ['[amenity=parking]'],
    aliases: ['駐車場', 'パーキング', 'parking'],
    iconName: 'parking',
  },
  {
    category: 'shop',
    label: '店舗',
    filters: ['[shop]'],
    aliases: ['店', '買い物', 'ショップ', 'shop', 'store'],
    iconName: 'shop',
  },
  {
    category: 'toilets',
    label: 'トイレ',
    filters: ['[amenity=toilets]'],
    aliases: ['トイレ', 'お手洗い', 'toilet', 'restroom'],
    iconName: 'toilets',
  },
  {
    category: 'atm',
    label: 'ATM・銀行',
    filters: ['[amenity=atm]', '[amenity=bank]'],
    aliases: ['ATM', '銀行', 'atm', 'bank'],
    iconName: 'atm',
  },
  {
    category: 'hotel',
    label: '宿泊',
    filters: ['[tourism=hotel]', '[tourism=hostel]'],
    aliases: ['ホテル', '宿', '宿泊', 'hotel'],
    iconName: 'hotel',
  },
];

export function findCategory(input: string): CategoryDefinition | undefined {
  const q = input.trim().toLowerCase();
  return CATEGORY_DEFINITIONS.find(
    (def) =>
      def.category === q ||
      def.label.toLowerCase() === q ||
      def.aliases.some((a) => a.toLowerCase() === q || q.includes(a.toLowerCase())),
  );
}

export function categoryOfTags(tags: Record<string, string>): PoiCategory {
  if (tags.shop === 'convenience') return 'convenience';
  if (tags.amenity === 'cafe') return 'cafe';
  if (tags.amenity === 'restaurant' || tags.amenity === 'fast_food') return 'restaurant';
  if (tags.amenity === 'hospital' || tags.amenity === 'clinic') return 'hospital';
  if (tags.amenity === 'school' || tags.amenity === 'university') return 'school';
  if (tags.leisure === 'park' || tags.leisure === 'garden') return 'park';
  if (tags.railway === 'station' || tags.public_transport === 'station') return 'station';
  if (tags.amenity === 'parking') return 'parking';
  if (tags.amenity === 'toilets') return 'toilets';
  if (tags.amenity === 'atm' || tags.amenity === 'bank') return 'atm';
  if (tags.tourism === 'hotel' || tags.tourism === 'hostel') return 'hotel';
  if (tags.shop) return 'shop';
  return 'other';
}

export function categoryIcon(category: PoiCategory): IconName {
  return CATEGORY_DEFINITIONS.find((d) => d.category === category)?.iconName ?? 'pin';
}
