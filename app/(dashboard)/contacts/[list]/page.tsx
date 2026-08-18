'use client'

import { useParams } from 'next/navigation'
import { Section } from '@/components/section'
import { ListDetailPanel } from '@/components/list-detail'

export default function ContactListPage() {
  const { list } = useParams<{ list: string }>()
  return (
    <Section>
      {state => <ListDetailPanel list={decodeURIComponent(list)} state={state} />}
    </Section>
  )
}
