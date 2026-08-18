'use client'

import { LeadsPanel } from '@/components/leads-panel'
import { Section } from '@/components/section'

export default function Page() {
  return <Section>{state => <LeadsPanel state={state} />}</Section>
}
