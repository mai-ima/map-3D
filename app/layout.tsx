import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Immersive Japan Map — オープンデータで作る 3D 日本地図',
  description:
    'OpenStreetMap・PLATEAU・国土地理院のオープンデータを使い、日本の実在都市をリアルタイム 3D で探索・ナビゲーションできるオープンソース地図。',
  applicationName: 'Immersive Japan Map',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Immersive Japan Map',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // 3D 操作中に誤ってページ全体がズームされないようにする
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#060b12',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="bg-ink-950 text-mist-100 antialiased">{children}</body>
    </html>
  );
}
