import "./globals.css";
import type { Metadata, Viewport } from "next";
import AuthWrapper from "@/components/AuthWrapper";

export const metadata: Metadata = {
  title: "namu-dashboard",
  description: "Sales + HR 통합 대시보드",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "나무",
    statusBarStyle: "black-translucent",
  },
  icons: {
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#2b2f26",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css" />
      </head>
      <body>
        <AuthWrapper>{children}</AuthWrapper>
      </body>
    </html>
  );
}