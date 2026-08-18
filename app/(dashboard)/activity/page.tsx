'use client'

import { ActivityChart } from '@/components/activity-chart'
import { ActivityPanel } from '@/components/activity-panel'
import { SectionCards } from '@/components/section-cards'
import { Section } from '@/components/section'

export default function Page() {
  return (
    <Section>
      {state => (
        <>
          <SectionCards state={state} />
          <ActivityChart state={state} />
          <ActivityPanel state={state} />
        </>
      )}
    </Section>
  )
}
