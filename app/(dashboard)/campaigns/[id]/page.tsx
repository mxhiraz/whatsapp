'use client'

import { useParams } from 'next/navigation'
import { Section } from '@/components/section'
import { CampaignDetailPanel } from '@/components/campaign-detail'

export default function CampaignPage() {
  const { id } = useParams<{ id: string }>()
  return <Section>{state => <CampaignDetailPanel id={Number(id)} state={state} />}</Section>
}
