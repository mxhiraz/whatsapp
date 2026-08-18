'use client'

import { SettingsPanel } from '@/components/settings-panel'
import { Section } from '@/components/section'

export default function Page() {
  return <Section>{state => <SettingsPanel state={state} />}</Section>
}
