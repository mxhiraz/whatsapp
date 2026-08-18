import type { Metadata } from 'next'
import { Geist_Mono, Inter } from 'next/font/google'
import { QueryProvider } from '@/components/query-provider'
import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import './globals.css'

const inter = Inter({ variable: '--font-sans', subsets: ['latin'] })
const mono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'WA Outreach',
  description: 'Bulk contact lists, follow-up sequences, number rotation, paced sending and reply detection for WhatsApp.',
}

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="bg-background text-foreground min-h-full text-[15px] tracking-tight">
        <ThemeProvider>
          <QueryProvider>
            <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
            <Toaster position="top-center" />
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
