'use client'

import { NumbersPanel } from '@/components/numbers-panel'
import { Section } from '@/components/section'

export default function Page() {
  return <Section>{(state, refresh) => <NumbersPanel state={state} refresh={refresh} />}</Section>
}
