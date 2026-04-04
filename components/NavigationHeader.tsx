"use client";
import { useRouter } from 'next/navigation';
import { ArrowLeft, Home } from 'lucide-react';

export function NavigationHeader() {
  const router = useRouter();

  const buttonStyles = "flex items-center justify-center px-4 py-2 text-sm font-medium transition-colors border rounded-md hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

  return (
    <div className="flex items-center justify-between p-4 border-b bg-background/95 backdrop-blur sticky top-0 z-50">
      <div className="flex gap-2">
        {/* Back Button */}
        <button 
          className={`${buttonStyles} bg-background border-input`}
          onClick={() => router.back()} // Changed to router.back() for better UX
        >
          <ArrowLeft className="mr-2 h-4 w-4" /> Back
        </button>

        {/* Home Button */}
        <button 
          className={`${buttonStyles} bg-ghost border-transparent`}
          onClick={() => router.push('/dashboard')}
        >
          <Home className="h-4 w-4" />
        </button>
      </div>
      
      <h2 className="text-sm font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
        Superior Cloud Intelligence
      </h2>
    </div>
  );
}