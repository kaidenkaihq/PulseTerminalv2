import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "PulseTerminal — Market intelligence",
  description:
    "Transparent real-time crypto signals, forecast validation and paper trading.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
