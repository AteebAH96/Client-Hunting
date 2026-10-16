import type { Metadata } from 'next';
export const metadata: Metadata = { title: 'Client Hunter', description: 'Your private lead finder and outreach notebook.' };
export default function Layout({children}: Readonly<{children:React.ReactNode}>) { return <html lang="en"><body>{children}</body></html>; }
