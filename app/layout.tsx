import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'switchboard',
  description: "Akme's phone and SMS line",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
