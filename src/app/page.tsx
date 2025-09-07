// app/page.tsx
import type { Metadata } from 'next'
import ScoreOSMD from '@/components/ScoreOSMD'

export const metadata: Metadata = {
  title: 'Music Viewer v2',
  description: 'Next.js + OSMD score viewer',
}

export default function Home() {
  return (
    <main className='min-h-screen w-full bg-white text-gray-900'>
      <header className='w-full border-b p-4 md:p-6'>
        <h1 className='text-xl md:text-2xl font-semibold'>Music Viewer v2</h1>
        <p className='text-sm md:text-base text-gray-600'>
          Next.js + OpenSheetMusicDisplay
        </p>
      </header>

      <section className='mx-auto max-w-6xl p-4 md:p-6'>
        {/* If your ScoreOSMD component needs props (e.g., a URL), pass them here */}
        <ScoreOSMD src="/scores/gymnopedie-no-1-satie.mxl"/>
      </section>
    </main>
  )
}
