import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "나무컴퍼니 Dashboard",
  description: "나무컴퍼니 내부 대시보드 (Sales / HR)",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <head>
        {/* Pretendard Webfont */}
        <link
          rel="stylesheet"
          as="style"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
