'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

/**
 * Shown only when APP_PASSWORD is set. The password is checked server-side and
 * exchanged for a signed cookie, so the password itself is never stored client-side.
 */
export default function Login() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'could not sign in' }))
        throw new Error(body.error ?? 'could not sign in')
      }
      // The cookie is set by the response, so a refresh is what lets the proxy see it.
      router.replace('/')
      router.refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="tracking-tighter">WA Outreach</CardTitle>
          <CardDescription>Enter the password for this install.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-3">
            <Input
              type="password"
              autoFocus
              value={password}
              placeholder="Password"
              onChange={e => setPassword(e.target.value)}
            />
            {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
            <Button type="submit" className="w-full" disabled={busy || !password}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
