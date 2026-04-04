"use client"; // We need this to check the current URL path

import { usePathname } from 'next/navigation';
import { NavigationHeader } from '@/components/NavigationHeader';
import "./globals.css";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  
  // Define pages where you DON'T want the header (like the landing page)
  const isLandingPage = pathname === "/"; 

  return (
    <html lang="en">
      <body className="antialiased">
        {/* Only show the header if we are not on the landing page */}
        {!isLandingPage && <NavigationHeader />}
        
        <main>{children}</main>
      </body>
    </html>
  );
}