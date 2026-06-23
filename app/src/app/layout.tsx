import type { Metadata } from "next";
import type { ReactNode } from "react";
import { THEME_INIT_SCRIPT } from "@/components/shared/theme-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Operator Console",
  description: "Control plane for the Operator orchestrator",
};

export default function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}): React.ReactElement {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
