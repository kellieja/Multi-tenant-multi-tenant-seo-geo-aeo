import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { ToastProvider } from "@/components/ui/toast";
import { PRODUCT_NAME } from "@/lib/brand";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: PRODUCT_NAME, template: `%s · ${PRODUCT_NAME}` },
  description: "Multi-site SEO, AEO and GEO operations platform",
  robots: { index: false, follow: false },
};

// Applies the stored colour-scheme override before first paint (FOUC prevention only).
const schemeScript = `try{var s=localStorage.getItem("color-scheme");if(s)document.querySelector('meta[name="color-scheme"]').content=s}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
        <script dangerouslySetInnerHTML={{ __html: schemeScript }} />
      </head>
      <body className="min-h-dvh font-sans text-[13px]">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
