'use client'

import { CampaignsPanel } from '@/components/campaigns-panel'
import { Section } from '@/components/section'

export default function Page() {
  return <Section>{state => <CampaignsPanel state={state} />}</Section>
}
