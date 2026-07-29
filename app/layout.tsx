import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'switchboard',
  description: "Akme's phone and SMS line",
  // A backend has no business shipping a favicon, but a browser will ask for one
  // anyway and log a 404 when it is missing. Declaring an empty icon stops the
  // request instead of putting an image back just to silence it.
  icons: { icon: 'data:,' },
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
