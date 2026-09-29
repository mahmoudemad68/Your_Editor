import type { ReactNode } from "react";

export const metadata = {
  title: "EditAgent",
  description: "EditAgent foundation scaffold",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
